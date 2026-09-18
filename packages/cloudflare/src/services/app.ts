import { Effect, Option } from "effect"
import * as Provider from "@deploykit/core/provider"
import { toProviderError } from "./error.js"
import type { CloudflareClient } from "./client.js"

/**
 * A Pages project as the portable App.
 *
 * `id` is the NAME, not the uuid Cloudflare also returns. Every Pages endpoint
 * addresses a project by name, so an App carrying the uuid would be an App you
 * cannot use. This is the clearest case of a provider whose identity is a name,
 * which is why `getDeployment` had to take the app as well as the deployment.
 */
const toApp = (project: { id: string; name: string }) =>
  Provider.App.make({
    id: Provider.appId.make(project.name),
    name: Provider.appName.make(project.name)
  })

export const createPagesProject = (cloudflare: CloudflareClient, name: string) =>
  cloudflare.createProject(name).pipe(
    Effect.map(toApp),
    Effect.mapError(cause => toProviderError(cause, { appName: name }))
  )

export const getPagesProject = (cloudflare: CloudflareClient, name: string) =>
  cloudflare.getProject(name).pipe(
    Effect.map(toApp),
    Effect.mapError(cause => toProviderError(cause, { appId: name }))
  )

export const deletePagesProject = (cloudflare: CloudflareClient, name: string) =>
  cloudflare
    .deleteProject(name)
    .pipe(Effect.mapError(cause => toProviderError(cause, { appId: name })))

/**
 * Adoption works here for the same reason identity is a name: asking for a
 * project by name is the only way to ask at all. A 404 is an answer.
 */
export const findPagesProjectByName = (cloudflare: CloudflareClient, name: string) =>
  cloudflare.getProject(name).pipe(
    Effect.map(project => Option.some(toApp(project))),
    Effect.catchTag("CloudflareApiError", cause =>
      cause.statusCode === 404
        ? Effect.succeed(Option.none<Provider.App>())
        : Effect.fail(toProviderError(cause, { appName: name }))
    )
  )
