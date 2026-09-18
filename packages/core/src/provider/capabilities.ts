/** What a provider can actually do, so optional features are declared rather than silently emulated. */

import type { Provider } from "./provider.ts"

export interface Capabilities {
  /**
   * The provider can resolve an app by name, so deploykit can adopt an app whose
   * stored mapping was lost instead of creating a duplicate.
   */
  readonly adoptByName: boolean
}

/**
 * Derived from what the adapter actually implements, never declared alongside
 * it. A hand-written record can claim a capability the adapter does not have and
 * nothing would catch the drift; presence of the method is the single fact, and
 * both readers see it.
 */
export const capabilitiesOf = (provider: Provider): Capabilities => ({
  adoptByName: provider.findAppByName !== undefined
})
