import type { Context, FileSystem } from "effect"
import { Effect, Layer, ManagedRuntime, Option, Schedule } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import type { Artifact, Provider } from "@deploykit/core"
import { Deploykit, Manifest, Source } from "@deploykit/core"
import * as Telemetry from "@deploykit/core/telemetry"
import { callback, ClientClosedError, rejectIfAborted, unwrap } from "./runtime.js"
import type { RunOptions } from "./runtime.js"

export interface GateOption {
  /** Shares request rate with other processes using the same token, e.g. through Redis. */
  readonly gate?: Provider.PromiseRequestGate
}

export interface ClientOptions extends Deploykit.Limits {
  readonly onEvent?: (event: Telemetry.Event) => void | Promise<void>
}
export type DeployOptions<D extends object = object> = Omit<Deploykit.DeployOptions, "onProgress"> &
  D &
  RunOptions & {
    readonly onProgress?: (progress: Provider.DeployProgress) => void | Promise<void>
  }

/** How long to poll for a terminal status. Defaults: every second, for up to five minutes. */
export interface WaitOptions extends RunOptions {
  readonly intervalMs?: number
  readonly timeoutMs?: number
  /** Consecutive provider errors to ride out before failing. Default 3. */
  readonly tolerateFailures?: number
}

const toWait = ({
  intervalMs = 1000,
  timeoutMs = 300_000,
  tolerateFailures
}: WaitOptions = {}) => ({
  schedule: Schedule.spaced(intervalMs).pipe(Schedule.upTo({ duration: timeoutMs })),
  ...(tolerateFailures === undefined ? {} : { tolerateFailures })
})

/** A Promise face over one `Deploykit` layer. Each method runs the matching Effect method. */
export const makeClient = <D extends object = object>(
  layer: Layer.Layer<Deploykit.Deploykit, unknown, FileSystem.FileSystem>,
  config: ClientOptions
) => {
  const runtime = ManagedRuntime.make(layer.pipe(Layer.provide(NodeFileSystem.layer)))
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let closing: Promise<void> | undefined
  const run = <A, E>(
    effect: Effect.Effect<A, E, Deploykit.Deploykit>,
    options: RunOptions = {}
  ): Promise<A> => {
    if (lifetime.signal.aborted)
      return Promise.reject(new ClientClosedError({ message: "Client is closed" }))
    const aborted = rejectIfAborted(options.signal)
    if (aborted !== undefined) return aborted
    const observed =
      config.onEvent === undefined
        ? effect
        : effect.pipe(
            Effect.provideService(Telemetry.Observer, event => callback(config.onEvent!, event))
          )
    const signal =
      options.signal === undefined
        ? lifetime.signal
        : AbortSignal.any([lifetime.signal, options.signal])
    const promise = runtime.runPromiseExit(observed, { signal }).then(unwrap)
    pending.add(promise)
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise)
    )
    return promise
  }
  const close = () => {
    if (closing === undefined) {
      lifetime.abort()
      closing = Promise.allSettled([...pending]).then(() => runtime.dispose())
    }
    return closing
  }
  /** JSON strings are parsed here; `Deploykit.deployManifest` decodes either way. */
  const parse = (manifest: unknown): Effect.Effect<unknown, Provider.ValidationError> =>
    typeof manifest === "string" ? Manifest.fromJson(manifest) : Effect.succeed(manifest)
  /** Call one `Deploykit` method as a Promise. */
  const call = <A, E>(
    operation: (kit: Context.Service.Shape<typeof Deploykit.Deploykit>) => Effect.Effect<A, E>,
    options?: RunOptions
  ) => run(Effect.flatMap(Deploykit.Deploykit, operation), options)
  const deployOptions = (options?: DeployOptions<D>) => {
    // Spread only what was set: exactOptionalPropertyTypes rejects explicit undefined.
    const { onProgress, activation, target, operationId, meta, ...rest } = options ?? {}
    return {
      ...rest,
      ...(activation === undefined ? {} : { activation }),
      ...(target === undefined ? {} : { target }),
      ...(operationId === undefined ? {} : { operationId }),
      ...(meta === undefined ? {} : { meta }),
      ...(onProgress === undefined
        ? {}
        : { onProgress: (event: Provider.DeployProgress) => callback(onProgress, event) })
    }
  }
  return {
    close,
    [Symbol.asyncDispose]: close,
    getCapabilities: (options?: RunOptions) =>
      call(kit => Effect.succeed(kit.capabilities), options),
    createApp: (name: string, options?: RunOptions) => call(kit => kit.createApp(name), options),
    getApp: (appId: string, options?: RunOptions) => call(kit => kit.getApp(appId), options),
    deleteApp: (appId: string, options?: RunOptions) => call(kit => kit.deleteApp(appId), options),
    findAppByName: (name: string, options?: RunOptions) =>
      call(kit => kit.findAppByName(name).pipe(Effect.map(Option.getOrUndefined)), options),
    setAccess: (appId: string, access: Provider.Access, options?: RunOptions) =>
      call(kit => kit.setAccess(appId, access), options),
    getDeployment: (appId: string, deploymentId: string, options?: RunOptions) =>
      call(kit => kit.getDeployment(appId, deploymentId), options),
    activateDeployment: (appId: string, deploymentId: string, options?: RunOptions) =>
      call(kit => kit.activateDeployment(appId, deploymentId), options),
    getActivation: (appId: string, deploymentId: string, options?: RunOptions) =>
      call(kit => kit.getActivation(appId, deploymentId), options),
    reconcileDeployment: (appId: string, operationId: string, options?: RunOptions) =>
      call(kit => kit.reconcileDeployment(appId, operationId), options),
    /** One page of an app's deployments, newest first. */
    listDeployments: (appId: string, options?: Provider.ListDeploymentsOptions & RunOptions) =>
      call(
        kit =>
          kit.listDeployments(appId, {
            ...(options?.target === undefined ? {} : { target: options.target }),
            ...(options?.limit === undefined ? {} : { limit: options.limit })
          }),
        options
      ),
    deleteDeployment: (appId: string, deploymentId: string, options?: RunOptions) =>
      call(kit => kit.deleteDeployment(appId, deploymentId), options),
    /** Point production back at an earlier successful production deployment. */
    rollback: (appId: string, deploymentId: string, options?: RunOptions) =>
      call(kit => kit.rollback(appId, deploymentId), options),
    deploy: (appId: string, artifact: Artifact.Artifact, options?: DeployOptions<D>) =>
      call(kit => kit.deploy(appId, artifact, deployOptions(options)), options),
    waitUntilReady: (appId: string, deploymentId: string, options?: WaitOptions) =>
      call(kit => kit.waitUntilReady(appId, deploymentId, toWait(options)), options),
    /** Deploy, then wait for it to go live. Rejects with `DeploymentFailedError` if it fails. */
    deployAndWait: (
      appId: string,
      artifact: Artifact.Artifact,
      options?: DeployOptions<D> & { readonly wait?: Omit<WaitOptions, "signal"> }
    ) =>
      call(
        kit =>
          kit.deployAndWait(appId, artifact, {
            ...deployOptions(options),
            wait: toWait(options?.wait)
          }),
        options
      ),
    deployDirectory: (appId: string, directory: string, options?: DeployOptions<D>) =>
      call(kit => kit.deployDirectory(appId, directory, deployOptions(options)), options),
    deployManifest: (
      appId: string,
      manifest: unknown,
      read: Source.StreamReader,
      options?: DeployOptions<D>
    ) =>
      call(
        kit =>
          parse(manifest).pipe(
            Effect.flatMap(manifest =>
              kit.deployManifest(
                appId,
                manifest,
                Source.fromReadableStream(read),
                deployOptions(options)
              )
            )
          ),
        options
      )
  }
}
