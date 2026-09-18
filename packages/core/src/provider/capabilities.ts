/** What a provider can actually do, so optional features are declared rather than silently emulated. */

import type { Provider } from "./provider.ts"

/** How a provider can restrict who may open a deployment. */
export type AccessMode = "public" | "password" | "sso"

export interface Capabilities {
  /**
   * The provider can resolve an app by name, so deploykit can adopt an app
   * whose stored mapping was lost instead of creating a duplicate.
   */
  readonly adoptByName: boolean
  /**
   * Which access modes `setAccess` accepts. Empty when the provider cannot
   * restrict access at all, which is also when `setAccess` is absent.
   */
  readonly accessModes: ReadonlySet<AccessMode>
}

/**
 * Derived from what the adapter implements wherever that is possible, and
 * declared only where it is not.
 *
 * Presence of a method is a fact nothing can contradict, so `adoptByName` is
 * read off `findAppByName` and cannot drift. `accessModes` is different in
 * kind: every provider with `setAccess` has the method, but they differ in
 * which modes they accept, and no amount of looking at the object reveals
 * that. So the adapter states it, and states it in one place rather than
 * scattering the knowledge through its call sites.
 */
export const capabilitiesOf = (provider: Provider): Capabilities => ({
  adoptByName: provider.findAppByName !== undefined,
  accessModes: provider.accessModes ?? new Set()
})
