import { expect, test } from "vitest"
import { Platform, Provider } from "@deploykit/core"

const provider = (fields: Partial<ConstructorParameters<typeof Provider.ProviderError>[0]>) =>
  new Provider.ProviderError({ message: "x", provider: "p", ...fields })

test.each([
  ["adapter's own advice wins", provider({ recovery: "fix-input", statusCode: 503 }), "fix-input"],
  ["lost response", provider({ outcome: "unknown" }), "reconcile"],
  ["rate limited", provider({ statusCode: 429 }), "retry"],
  ["forbidden", provider({ statusCode: 403 }), "fix-input"],
  [
    "slow build",
    new Platform.DeploymentTimeoutError({ deploymentId: "d", lastStatus: "deploying" }),
    "wait"
  ],
  ["failed build", new Platform.DeploymentFailedError({ deploymentId: "d" }), "fix-input"],
  [
    "missing feature",
    new Provider.UnsupportedError({ provider: "p", capability: "c", message: "x" }),
    "unsupported"
  ]
] as const)("%s", (_name, error, expected) => {
  expect(Provider.recoveryOf(error)).toBe(expected)
})
