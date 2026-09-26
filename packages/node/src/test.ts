import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Deploykit, Provider } from "@deploykit/core"
import { make } from "@deploykit/test"
import type { TestProviderConfig } from "@deploykit/test"
import { makeClient } from "./client.js"
import { run } from "./runtime.js"
import type { ClientOptions } from "./client.js"

export type { TestProviderConfig, TestState, DeploymentRecord } from "@deploykit/test"
export type TestClientOptions = TestProviderConfig & ClientOptions

/**
 * A Promise client over an in-memory provider, for testing code that deploys.
 * Nothing leaves the process. `snapshot()` shows every app and deployment it saw.
 */
export const createTestClient = (options: TestClientOptions = {}) => {
  const test = Effect.runSync(make(options))
  const client = makeClient(
    Deploykit.layer(options).pipe(
      Layer.provide(Layer.succeed(Provider.DeploymentProvider, test.provider)),
      Layer.provide(NodeFileSystem.layer)
    ),
    options
  )
  return {
    ...client,
    snapshot: () => run(test.snapshot),
    /** The exact files a deployment was created from. */
    artifactFor: (deploymentId: string) => run(test.artifactFor(deploymentId))
  }
}
