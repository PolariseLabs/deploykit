/**
 * Mapping Cloudflare Pages' deployment state onto the portable one.
 *
 * This is where the second provider earns its keep. Vercel reports a single
 * `readyState`; Cloudflare reports a stage AND a status, and the meaning is in
 * the pair. The trap is `build/success`, which is not deployed: it means the
 * build finished and the deploy stage has not run. A mapping that keyed off
 * status alone would report a site live while it was still deploying.
 */

import { Schema } from "effect"
import * as Provider from "@deploykit/core/provider"

/** The build pipeline, in order. Only the last one succeeding means live. */
export const pagesStage = Schema.Literals(["queued", "initialize", "clone_repo", "build", "deploy"])
export type PagesStage = typeof pagesStage.Type

export const pagesStatus = Schema.Literals(["idle", "active", "success", "failure", "canceled"])
export type PagesStatus = typeof pagesStatus.Type

export const pagesLatestStage = Schema.Struct({
  name: pagesStage,
  status: pagesStatus
})

/**
 * Both dimensions decide the answer.
 *
 * A failure or cancellation at any stage is terminal. Otherwise the stage says
 * how far along we are, and only `deploy/success` is actually serving.
 */
export const mapLatestStage = (
  stage: PagesStage,
  status: PagesStatus
): Provider.DeploymentStatus => {
  switch (status) {
    case "failure":
    case "canceled":
      return "failed"
    case "idle":
      // Not started. Even at the deploy stage, idle means it has not run.
      return "pending"
    case "active":
      // Queued and initialize are still waiting to do anything meaningful;
      // from clone_repo onward there is real work happening.
      return stage === "queued" || stage === "initialize" ? "pending" : "deploying"
    case "success":
      // The only success that means live. Every earlier stage succeeding just
      // means the next one is about to start.
      return stage === "deploy" ? "deployed" : "deploying"
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

/**
 * A Pages deployment as the portable model.
 *
 * `appId` is the project NAME, because that is how Cloudflare addresses a
 * project everywhere: there is no opaque id you can use instead.
 *
 * A skipped deployment reports as failed. It did not deploy, and no caller so
 * far would act differently on the distinction, so it rides in `reason`
 * rather than earning a fifth status.
 */
export const toDeployment = (
  deployment: {
    readonly id: string
    readonly url?: string | undefined
    readonly project_name?: string | undefined
    readonly latest_stage: { readonly name: PagesStage; readonly status: PagesStatus }
    readonly is_skipped?: boolean | undefined
  },
  fallbackProjectName: string
): Provider.Deployment =>
  Provider.Deployment.make({
    id: Provider.deploymentId.make(deployment.id),
    name: Provider.deploymentName.make(deployment.id),
    appId: Provider.appId.make(deployment.project_name ?? fallbackProjectName),
    status:
      deployment.is_skipped === true
        ? "failed"
        : mapLatestStage(deployment.latest_stage.name, deployment.latest_stage.status),
    ...(deployment.url !== undefined ? { url: Provider.deploymentUrl.make(deployment.url) } : {}),
    ...(deployment.is_skipped === true ? { reason: "skipped" } : {})
  })
