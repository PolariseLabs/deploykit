/** The Effect entry point: a provider plus the budgets every deploy shares. */

import { Context, Effect, FileSystem, Layer } from "effect"
import * as Artifact from "./artifact/index.js"
import * as Manifest from "./manifest.js"
import { DeploymentFailedError } from "./platform/errors.js"
import { waitUntilReady, type WaitOptions } from "./platform/wait.js"
import * as Provider from "./provider/index.js"
import type { FileSource } from "./source.js"
import { makeStagingBudget } from "./staging.js"
import { makeBudget } from "./transfer.js"

/** Per-deploy options. Budgets are owned by the layer, so callers cannot pass their own. */
export type DeployOptions = Omit<Provider.DeployOptions, "transferBudget" | "stagingBudget">

export interface DeployAndWaitOptions extends DeployOptions {
  readonly wait?: WaitOptions
}

export interface Limits {
  /** Bytes all concurrent deploys may hold in memory at once. */
  readonly memoryBudgetBytes?: number
  /** Bytes all concurrent deploys may stage on disk at once. */
  readonly stagingBudgetBytes?: number
  readonly maxFileBytes?: number
}

const make = (limits: Limits) =>
  Effect.gen(function* () {
    const provider = yield* Provider.DeploymentProvider
    const fs = yield* FileSystem.FileSystem
    const memory = yield* makeBudget(limits.memoryBudgetBytes)
    const staging = yield* makeStagingBudget(limits.stagingBudgetBytes, limits.maxFileBytes)

    /** Optional provider operations fail with `UnsupportedError` instead of being absent. */
    const optional =
      <Args extends ReadonlyArray<unknown>, A, E>(
        capability: string,
        operation: ((...args: Args) => Effect.Effect<A, E>) | undefined
      ) =>
      (...args: Args): Effect.Effect<A, E | Provider.UnsupportedError> =>
        operation === undefined
          ? Effect.fail(
              new Provider.UnsupportedError({
                provider: provider.name,
                capability,
                message: `${capability} is unavailable`
              })
            )
          : operation(...args)

    const deploy = (appId: string, artifact: Artifact.Artifact, options: DeployOptions = {}) =>
      provider.deploy(appId, artifact, {
        ...options,
        transferBudget: memory,
        stagingBudget: staging
      })

    /** A `failed` deployment becomes `DeploymentFailedError`; the caller asked for a live one. */
    const deployAndWait = (
      appId: string,
      artifact: Artifact.Artifact,
      { wait, ...options }: DeployAndWaitOptions = {}
    ) =>
      deploy(appId, artifact, options).pipe(
        Effect.flatMap(created => waitUntilReady(provider, appId, created.id, wait)),
        Effect.flatMap(deployment =>
          deployment.status === "failed"
            ? Effect.fail(
                new DeploymentFailedError({
                  deploymentId: deployment.id,
                  ...(deployment.reason === undefined ? {} : { reason: deployment.reason })
                })
              )
            : Effect.succeed(deployment)
        )
      )

    return {
      capabilities: Provider.capabilitiesOf(provider),
      createApp: provider.createApp,
      getApp: provider.getApp,
      deleteApp: provider.deleteApp,
      getDeployment: provider.getDeployment,
      findAppByName: optional("adoptByName", provider.findAppByName),
      setAccess: optional("access", provider.setAccess),
      activateDeployment: optional("activation", provider.activateDeployment),
      getActivation: optional("activation", provider.getActivation),
      reconcileDeployment: optional("reconciliation", provider.reconcileDeployment),
      listDeployments: optional("listDeployments", provider.listDeployments),
      deleteDeployment: optional("deleteDeployment", provider.deleteDeployment),
      rollback: optional("rollback", provider.rollback),
      deploy,
      deployAndWait,
      waitUntilReady: (appId: string, deploymentId: string, options?: WaitOptions) =>
        waitUntilReady(provider, appId, deploymentId, options),
      deployDirectory: (appId: string, directory: string, options?: DeployOptions) =>
        Artifact.fromDirectory(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.flatMap(artifact => deploy(appId, artifact, options))
        ),
      /** `manifest` is decoded here, so it can come straight from JSON.parse or a queue. */
      deployManifest: (
        appId: string,
        manifest: unknown,
        source: FileSource,
        options?: DeployOptions
      ) =>
        Manifest.toArtifact(manifest, source).pipe(
          Effect.flatMap(artifact => deploy(appId, artifact, options))
        )
    }
  })

export class Deploykit extends Context.Service<
  Deploykit,
  Effect.Success<ReturnType<typeof make>>
>()("@deploykit/Deploykit") {}

/** Builds the shared service from a provider; adapters expose this through their own layers. */
export const layer = (limits: Limits = {}) => Layer.effect(Deploykit, make(limits))
