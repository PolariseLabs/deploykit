/** The adapter contract. Declared here, implemented by @deploykit/vercel and @deploykit/test. */

import type { Option } from "effect"
import type { AccessMode } from "./capabilities.js"
import { Context, Effect, Layer, Schema } from "effect"

import type { ProviderError } from "./errors.js"
import type { Artifact } from "../artifact/index.js"

export const appId = Schema.String.pipe(Schema.brand("AppId"))
export const appName = Schema.String.pipe(Schema.brand("AppName"))
export const deploymentId = Schema.String.pipe(Schema.brand("DeploymentId"))
export const deploymentName = Schema.String.pipe(Schema.brand("DeploymentName"))
/**
 * The portable lifecycle of a deployment. Adapters map their provider's own
 * states onto these four. Deliberately unbranded: unlike an id, the literals
 * cannot be confused with another string type, so a brand would add friction
 * without adding safety.
 */
export const deploymentStatus = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("deploying"),
  Schema.Literal("deployed"),
  Schema.Literal("failed")
])
export type DeploymentStatus = typeof deploymentStatus.Type
/**
 * Whether a deployment has stopped moving. The single definition of "finished",
 * so pollers and state machines cannot disagree about it. A switch rather than
 * a boolean expression: adding a status turns the gap into a compile error.
 */
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
/**
 * Who may open a deployment. A closed union rather than a boolean, because
 * "not public" splits into meaningfully different things a caller chooses
 * between.
 */
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
  /**
   * Where this deployment can be reached, once it can be.
   *
   * A terminal status does not mean this URL is routable yet: the provider
   * assigns the domain after the deployment finishes. Observed on Vercel at
   * roughly 0.4s, 404ing before that. A caller that must know the site answers
   * has to ask the URL, and should expect to retry briefly.
   */
  url: Schema.optional(deploymentUrl),
  /** Why a failed deployment failed, when the provider says. */
  reason: Schema.optional(Schema.String)
}) {}

/**
 * Everything a provider can do that does not move bytes.
 *
 * Split out because where these run is not where `deploy` can run. Creating a
 * project, resolving one, setting access and polling a deployment are small
 * HTTP calls; deploying is a whole tree of files. Convex's V8 runtime gives a
 * function 64 MiB and thirty minutes, which is generous for the former and
 * nowhere near enough for the latter, where the consumer has seen 898 MB trees.
 *
 * So a caller that only needs the control plane depends on this and never
 * pulls a byte-mover, a hasher or a filesystem into its bundle. That matters
 * against a 32 MiB deployment-wide code limit.
 */
export interface ControlPlane {
  readonly name: string

  /** Create an isolated app for one tenant. */
  readonly createApp: (name: string) => Effect.Effect<App, ProviderError>

  /** Resolve an app that already exists. */
  readonly getApp: (id: string) => Effect.Effect<App, ProviderError>

  /**
   * Resolve an app by name, or None if the provider has none by that name.
   *
   * Optional, because a provider that addresses apps only by opaque id cannot
   * answer it. Where it exists, deploykit can adopt an app whose mapping was
   * lost, which is the difference between a create that self-heals and one that
   * leaks a duplicate on every retry. Declare it by implementing it.
   */
  readonly findAppByName?: (name: string) => Effect.Effect<Option.Option<App>, ProviderError>

  /**
   * Restrict who may open this app's deployments.
   *
   * Optional: a provider may have no access model at all. Where it exists the
   * modes differ, so an adapter that implements this also declares
   * `accessModes`. Worth setting explicitly on a freshly created app: a team
   * with protection on by default produces apps nobody outside it can reach,
   * which is wrong for something deployed on a customer's behalf.
   */
  readonly setAccess?: (id: string, access: Access) => Effect.Effect<void, ProviderError>

  /** Which modes `setAccess` accepts. Absent when `setAccess` is. */
  readonly accessModes?: ReadonlySet<AccessMode>

  /**
   * Remove an app. Needed to compensate a half-finished create, and for tenant
   * offboarding. Adapters may assume the app exists; callers that are not sure
   * should getApp first.
   */
  readonly deleteApp: (id: string) => Effect.Effect<void, ProviderError>

  /** Read one deployment back, for polling status and URL. */
  readonly getDeployment: (deploymentId: string) => Effect.Effect<Deployment, ProviderError>
}

/** The control plane plus the one operation that moves bytes. */
export interface Provider extends ControlPlane {
  /** Put an artifact into an app. */
  readonly deploy: (appId: string, artifact: Artifact) => Effect.Effect<Deployment, ProviderError>
}

export class DeploymentProvider extends Context.Service<DeploymentProvider, Provider>()(
  "@deploykit/DeploymentProvider"
) {}

/**
 * The control plane on its own, for a caller that cannot or should not deploy.
 *
 * A Provider satisfies this structurally, so an adapter needs nothing extra:
 * `Provider.controlLayer` derives it. Depend on this in a runtime that only
 * reads and polls.
 */
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
