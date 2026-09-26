/** The adapter contract. Declared here, implemented by @deploykit/vercel and @deploykit/test. */

import type { Option } from "effect"
import type { AccessMode } from "./capabilities.js"
import { Context, Effect, Layer, Schema } from "effect"

import type { StagingBudget } from "../staging.js"
import type { TransferBudget } from "../transfer.js"
import type { TransferError, ProviderError } from "./errors.js"
import type { Artifact } from "../artifact/index.js"

export const appId = Schema.String.pipe(Schema.brand("AppId"))
export const appName = Schema.String.pipe(Schema.brand("AppName"))
export const deploymentId = Schema.String.pipe(Schema.brand("DeploymentId"))
export const deploymentName = Schema.String.pipe(Schema.brand("DeploymentName"))

export const deploymentStatus = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("deploying"),
  Schema.Literal("deployed"),
  Schema.Literal("failed")
])
export type DeploymentStatus = typeof deploymentStatus.Type

export const isTerminal = (status: DeploymentStatus): boolean => {
  switch (status) {
    case "pending":
    case "deploying":
      return false
    case "deployed":
    case "failed":
      return true
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

export const deploymentUrl = Schema.String.pipe(Schema.brand("DeploymentUrl"))
export type DeploymentUrl = typeof deploymentUrl.Type
export type AppId = typeof appId.Type

export class UnsupportedError extends Schema.TaggedError<UnsupportedError>()("UnsupportedError", {
  provider: Schema.String,
  /** The operation or mode that is not available. */
  capability: Schema.String,
  message: Schema.String
}) {}

export type Access =
  | { readonly _tag: "Public" }
  | { readonly _tag: "Password"; readonly password: string }
  | { readonly _tag: "SingleSignOn" }

export class App extends Schema.Class<App>("App")({
  id: appId,
  name: appName
}) {}

export class Deployment extends Schema.Class<Deployment>("Deployment")({
  id: deploymentId,
  name: deploymentName,
  appId: appId,
  status: deploymentStatus,

  url: Schema.optional(deploymentUrl),
  /** Why a failed deployment failed, when the provider says. */
  reason: Schema.optional(Schema.String)
}) {}

export const Activation = Schema.Struct({
  appId: Schema.String,
  deploymentId: Schema.String,
  state: Schema.Literals(["pending", "active", "unknown"])
})
export type Activation = typeof Activation.Type
export type Reconciliation =
  | { readonly _tag: "Recovered"; readonly deployment: Deployment }
  | {
      readonly _tag: "Unknown"
      readonly candidates: ReadonlyArray<string>
      readonly reason: string
    }

export interface ControlPlane {
  readonly deferredActivation?: boolean
  readonly previewDeployments?: boolean
  readonly reconcileDeployment?: (
    appId: string,
    operationId: string
  ) => Effect.Effect<Reconciliation, ProviderError>
  readonly activateDeployment?: (
    appId: string,
    deploymentId: string
  ) => Effect.Effect<Activation, ProviderError | UnsupportedError>
  readonly getActivation?: (
    appId: string,
    deploymentId: string
  ) => Effect.Effect<Activation, ProviderError>

  readonly name: string

  /** Create an isolated app for one tenant. */
  readonly createApp: (name: string) => Effect.Effect<App, ProviderError>

  /** Resolve an app that already exists. */
  readonly getApp: (id: string) => Effect.Effect<App, ProviderError>

  readonly findAppByName?: (name: string) => Effect.Effect<Option.Option<App>, ProviderError>

  readonly setAccess?: (id: string, access: Access) => Effect.Effect<void, ProviderError>

  /** Which modes `setAccess` accepts. Absent when `setAccess` is. */
  readonly accessModes?: ReadonlySet<AccessMode>

  readonly deleteApp: (id: string) => Effect.Effect<void, ProviderError>

  readonly getDeployment: (
    appId: string,
    deploymentId: string
  ) => Effect.Effect<Deployment, ProviderError>

  /** One page of an app's deployments, newest first. */
  readonly listDeployments?: (
    appId: string,
    options?: ListDeploymentsOptions
  ) => Effect.Effect<ReadonlyArray<Deployment>, ProviderError>

  /** Delete one deployment. Refuses the one currently serving production. */
  readonly deleteDeployment?: (
    appId: string,
    deploymentId: string
  ) => Effect.Effect<void, ProviderError | UnsupportedError>

  /**
   * Point production back at an earlier successful production deployment,
   * without rebuilding. Pick the target with `listDeployments`.
   */
  readonly rollback?: (
    appId: string,
    deploymentId: string
  ) => Effect.Effect<Activation, ProviderError | UnsupportedError>
}

export interface ListDeploymentsOptions {
  readonly target?: "production" | "preview"
  /** Clamped to 1 to 100. Defaults to 20. */
  readonly limit?: number
}

/** The page size adapters request for `listDeployments`. */
export const listLimit = ({ limit }: ListDeploymentsOptions = {}) =>
  limit === undefined || !Number.isFinite(limit)
    ? 20
    : Math.min(100, Math.max(1, Math.trunc(limit)))

export type DeployProgress =
  | { readonly _tag: "Hashing"; readonly done: number; readonly total: number }
  | {
      readonly _tag: "Uploading"
      readonly done: number
      readonly total: number
      readonly bytes: number
    }
  | { readonly _tag: "Throttled"; readonly retryAfterMs?: number }
  | { readonly _tag: "Created"; readonly deploymentId: string }

export interface DeployOptions {
  readonly transferBudget?: TransferBudget
  readonly stagingBudget?: StagingBudget
  readonly activation?: "automatic" | "deferred"
  readonly operationId?: string

  readonly target?: "production" | "preview"

  readonly meta?: Readonly<Record<string, string>>

  /** Called as the deploy progresses. Failures here must not fail the deploy. */
  readonly onProgress?: (event: DeployProgress) => Effect.Effect<void>
}

/** The control plane plus the one operation that moves bytes. */
export interface Provider extends ControlPlane {
  /** Put an artifact into an app. */
  readonly deploy: (
    appId: string,
    artifact: Artifact,
    options?: DeployOptions
  ) => Effect.Effect<Deployment, ProviderError | TransferError | UnsupportedError>
}

export class DeploymentProvider extends Context.Service<DeploymentProvider, Provider>()(
  "@deploykit/DeploymentProvider"
) {}

export class DeploymentControl extends Context.Service<DeploymentControl, ControlPlane>()(
  "@deploykit/DeploymentControl"
) {}

/** Every full provider is also a control plane. */
export const controlLayer = Layer.effect(
  DeploymentControl,
  Effect.gen(function* () {
    const provider = yield* DeploymentProvider
    return provider
  })
)
