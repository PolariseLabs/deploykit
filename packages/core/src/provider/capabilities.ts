/** What a provider can actually do, so optional features are declared rather than silently emulated. */

import type { ControlPlane } from "./provider.ts"

/** How a provider can restrict who may open a deployment. */
export type AccessMode = "public" | "password" | "sso"

export interface Capabilities {
  readonly deferredActivation: boolean
  readonly previewDeployments: boolean
  readonly reconciliation: boolean

  readonly adoptByName: boolean

  readonly accessModes: ReadonlySet<AccessMode>
}

export const capabilitiesOf = (provider: ControlPlane): Capabilities => ({
  deferredActivation:
    provider.deferredActivation === true &&
    provider.activateDeployment !== undefined &&
    provider.getActivation !== undefined,
  previewDeployments: provider.previewDeployments === true,
  reconciliation: provider.reconcileDeployment !== undefined,
  adoptByName: provider.findAppByName !== undefined,
  accessModes: provider.accessModes ?? new Set()
})
