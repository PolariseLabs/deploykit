import { Effect, Option } from "effect"
import { Provider } from "@deploykit/core"
import { toProviderError } from "./error.js"
import type { VercelClient } from "./client.js"

const toApp = (project: { id: string; name: string }) =>
  Provider.App.make({
    id: Provider.appId.make(project.id),
    name: Provider.appName.make(project.name)
  })

export const createVercelProject = (vercel: VercelClient, name: string) =>
  vercel.createProject(name).pipe(
    Effect.map(toApp),
    Effect.mapError(cause => toProviderError(cause, { appName: name }))
  )

export const getVercelProject = (vercel: VercelClient, id: string) =>
  vercel.getProject(id).pipe(
    Effect.map(toApp),
    Effect.mapError(cause => toProviderError(cause, { appId: id }))
  )

/**
 * Vercel deletes by id or name. Returns void: the caller already knows which
 * app it asked to remove, and Vercel gives nothing else back.
 */
export const deleteVercelProject = (vercel: VercelClient, id: string) =>
  vercel.deleteProject(id).pipe(Effect.mapError(cause => toProviderError(cause, { appId: id })))

/**
 * Vercel resolves a project by id OR name, which is what makes adoption
 * possible here. A provider that only addresses apps by opaque id would omit
 * this operation entirely.
 *
 * A 404 becomes None rather than a failure, because "no such project" is an
 * answer. Every other status stays a failure, so an outage is never misread as
 * absence.
 */
export const findVercelProjectByName = (vercel: VercelClient, name: string) =>
  vercel.getProject(name).pipe(
    Effect.map(project => Option.some(toApp(project))),
    Effect.catchTag("VercelApiError", cause =>
      cause.statusCode === 404
        ? Effect.succeed(Option.none<Provider.App>())
        : Effect.fail(toProviderError(cause, { appName: name }))
    )
  )

/**
 * Vercel models access per project, as two mutually exclusive settings.
 * Clearing both is what makes a deployment reachable by anyone, which is the
 * right default for an app deployed on a customer's behalf.
 */
export const setVercelProjectAccess = (vercel: VercelClient, id: string, access: Provider.Access) =>
  vercel
    .setProjectAccess(
      id,
      access._tag === "Public"
        ? { _tag: "Public" }
        : access._tag === "SingleSignOn"
          ? { _tag: "VercelAuth" }
          : { _tag: "Password", password: access.password }
    )
    .pipe(Effect.mapError(cause => toProviderError(cause, { appId: id })))
