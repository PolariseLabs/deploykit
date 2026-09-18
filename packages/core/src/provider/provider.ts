/** The adapter contract. Declared here, implemented by @deploykit/vercel and @deploykit/test. */

import type { Effect, Option } from "effect"
import { Context, Schema } from "effect"

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

export interface Provider {
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

  /** Put an artifact into an app.  */
  readonly deploy: (appId: string, artifact: Artifact) => Effect.Effect<Deployment, ProviderError>

  /**
   * Remove an app. Needed to compensate a half-finished create, and for tenant
   * offboarding. Adapters may assume the app exists; callers that are not sure
   * should getApp first.
   */
  readonly deleteApp: (id: string) => Effect.Effect<void, ProviderError>

  /** Read one deployment back, for polling status and URL. */
  readonly getDeployment: (deploymentId: string) => Effect.Effect<Deployment, ProviderError>
}

export class DeploymentProvider extends Context.Service<DeploymentProvider, Provider>()(
  "@deploykit/DeploymentProvider"
) {}
