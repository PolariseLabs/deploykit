import { Effect } from "effect"
import type { VercelClient } from "./client.js"
import { Provider } from "@deploykit/core"

const toApp = (project: { id: string; name: string }) =>
  Provider.App.make({
    id: Provider.appId.make(project.id),
    name: Provider.appName.make(project.name)
  })

export const createVercelProject = (vercel: VercelClient, name: string) =>
  Effect.tryPromise({
    try: () =>
      vercel.projects.createProject({
        requestBody: {
          name
        }
      }),
    catch: cause =>
      new Provider.ProviderError({
        message: cause instanceof Error ? cause.message : "Unknown error",
        provider: "vercel",
        appName: name
      })
  }).pipe(Effect.map(project => toApp(project)))

export const getVercelProject = (vercel: VercelClient, id: string) =>
  Effect.tryPromise({
    try: () => vercel.projects.getProject({ idOrName: id }),
    catch: cause =>
      new Provider.ProviderError({
        message: cause instanceof Error ? cause.message : "Unknown error",
        provider: "vercel",
        appId: id
      })
  }).pipe(Effect.map(project => toApp(project)))

/**
 * Vercel deletes by id or name. Returns void: the caller already knows which
 * app it asked to remove, and Vercel gives nothing else back.
 */
export const deleteVercelProject = (vercel: VercelClient, id: string) =>
  Effect.tryPromise({
    try: () => vercel.projects.deleteProject({ idOrName: id }),
    catch: cause =>
      new Provider.ProviderError({
        message: cause instanceof Error ? cause.message : "Unknown error",
        provider: "vercel",
        appId: id
      })
  }).pipe(Effect.asVoid)
