# deploykit

An Effect-native deployment SDK for SaaS applications. The caller composes files,
chooses when to deploy, checks the result and decides when to activate it.

## Status

`0.1.0-alpha.1` is an alpha release candidate and is not fully provider-qualified.
Vercel and Cloudflare Pages have local adapter tests and packed consumer proofs.
A real Vercel smoke test on 2026-09-25 verified HTML, CSS, a Node.js function and a
9 MiB streamed asset in a temporary project, with SHA-256 checks and confirmed cleanup.
A separate real 2,187-file, 884.75 MB artifact also deployed successfully with deferred
activation, cache reuse and sampled browser/media verification. Isolated live tests
also cover Vercel activation, recovery, interruption, concurrent Fluid transfers,
Convex control calls and Pages streaming/worker execution. The real artifact passed
inside Fluid; fresh synthetic content with its size/duplicate structure exercised
cold uploads. See `BENCHMARKS.md` for measured workloads and limitations.

The API can change during alpha. Effect is pinned to `4.0.0-rc.112`; no other version
is claimed compatible. Runtime checks run on Node and Bun. Node must be at least
22.19; see `BENCHMARKS.md` for measured runtime configurations.

## Packages

| Package                 | Responsibility                                                   |
| ----------------------- | ---------------------------------------------------------------- |
| `@deploykit/core`       | Artifacts, manifests, sources, failures and provider contracts   |
| `@deploykit/vercel`     | Vercel prebuilt uploads and explicit provider operations         |
| `@deploykit/cloudflare` | Cloudflare Pages direct uploads and single-module worker bundles |
| `@deploykit/test`       | In-memory provider, lost-response simulation and app store       |
| `@deploykit/devtools`   | Local telemetry dashboard and bounded event collection           |
| `@deploykit/node`       | Promise clients over the same Effect code, for non-Effect apps   |

Core imports no provider SDK. Snapshots, releases, storage authorization, durable
workflows, database provisioning and application/browser checkers belong to callers.
A new game, generated configuration file or publishing step needs no SDK release.

## Documentation

Start with the [Vercel quickstart](docs/content/docs/guides/vercel.mdx),
[Pages quickstart](docs/content/docs/guides/pages.mdx) or [Effect guide](docs/content/docs/guides/effect.mdx).
The [API reference](docs/content/docs/reference/index.mdx) covers all six packages.
See [docs development](docs/README.md) to run the searchable documentation site locally.

## Usage

```typescript
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Deploykit } from "@deploykit/core"
import * as Vercel from "@deploykit/vercel"

const deployDirectory = (appId: string, directory: string) =>
  Effect.gen(function* () {
    const deploykit = yield* Deploykit.Deploykit
    return yield* deploykit.deployDirectory(appId, directory)
  })

// Reads VERCEL_TOKEN; `Vercel.layer({ token })` takes explicit options instead.
const DeploykitLive = Vercel.layerConfig().pipe(Layer.provide(NodeFileSystem.layer))
```

Without Effect, `@deploykit/node` runs the same service behind Promises:

```typescript
import { createClient } from "@deploykit/node/vercel"

const deploykit = createClient({ token: process.env.VERCEL_TOKEN! })
try {
  await deploykit.deployDirectory(appId, "./build", {
    target: "production",
    activation: "deferred",
    operationId: "publish-123"
  })
} finally {
  await deploykit.close()
}
```

Its methods reject with the same tagged errors (`ProviderError`, `UnsupportedError`, ...)
and accept an `AbortSignal`. Each adapter layer takes a `FileSystem`; adapters do not
select the runtime. The caller supplies the provider-specific tree: Vercel Build Output files
or Pages root assets. Pages supports `_worker.js` as an ESM entry module; deploykit
does not compile a `functions/` directory or resolve worker imports.

`deploy()` returns once creation is known. `getDeployment(appId, id)` observes once.
`deployAndWait(appId, artifact)` deploys and polls until the deployment is live, failing
with `DeploymentFailedError` if the provider reports a failed build; `waitUntilReady`
polls an existing deployment. Both exist on `Deploykit` and the Promise client
(`{ wait: { timeoutMs, intervalMs } }` there, an Effect schedule on `Deploykit`).
`Platform.layer` adds tenant-to-app mapping on top, with a caller-owned `TenantAppStore`.

`Platform.waitUntilServing(url, { timeoutMs: 60_000 })` is a separate optional helper.
It accepts 2xx by default, avoids redirects and cancels response bodies. Each request
has a 30-second limit; the overall deadline includes requests, polling and cleanup.
Custom schedules cannot extend that deadline, and custom fetch transports must honour
its abort signal. A deployed status is neither serving readiness nor evidence that
production routing has changed.

Consumer functions are in `examples/standalone.ts` and
`examples/coordinator-worker.ts`; `bun run check:packages` installs tarballs into a
clean directory, typechecks those consumers and runs them on Node and Bun with fake
HTTP endpoints. It never deploys to a real provider.

### Complete Vercel example

[`examples/public-api.ts`](examples/public-api.ts) uses only public exports. It loads
a prepared directory, adds a generated config file, deploys without activation,
waits for readiness and verifies the served config. Its telemetry observer can feed
any caller-owned logging or analytics system. The verification code belongs to the
consumer, not deploykit.

The prepared directory must contain `.vercel/output/config.json` and
`.vercel/output/static/`. Only put deployment content there. Generated website
files go under `.vercel/output/static/`; the coordinator example accepts an explicit
`configPath` because other providers use different layouts.

To run against your own isolated test project, set `VERCEL_TOKEN`, optional
`VERCEL_TEAM_ID`, `DEPLOYKIT_TEST_APP_ID`, `DEPLOYKIT_ARTIFACT_DIR` and a unique
`DEPLOYKIT_OPERATION_ID`, then run:

```sh
bun examples/public-api.ts --deploy
```

This creates a real deployment and leaves it available without activating production
routing. Importing the example alone performs no deployment. In a durable workflow,
persist the deployment receipt before waiting or checking it. An operation ID is a
recovery correlation key, not an exactly-once guarantee: reconcile an ambiguous
creation outcome instead of blindly retrying the whole function.

A separate isolated live qualification ran native Convex control calls, JSON handoff
and actual Fluid transfers from immutable HTTP sources. A standalone caller used
the same worker successfully. Convex and Fluid are optional consumer choices; neither
is a dependency or required workflow. See `BENCHMARKS.md` for evidence
and remaining qualification gates.

The standalone Node fixture pins `@effect/platform-node` to rc.112 and overrides
`@effect/platform-node-shared` to rc.112. This is deliberate: platform-node's
transitive prerelease range otherwise selects a newer, incompatible shared runtime.
Use the same override in an npm consumer and keep its Effect graph aligned:

```json
{
  "dependencies": {
    "effect": "4.0.0-rc.112",
    "@effect/platform-node": "4.0.0-rc.112"
  },
  "overrides": {
    "@effect/platform-node-shared": "4.0.0-rc.112"
  }
}
```

## Manifests and sources

Use `Manifest.decode`, `Manifest.encode`, `Manifest.fromJson` and
`Manifest.toArtifact`. The exported schemas describe the wire shape; `decode` adds
semantic validation and normalization. Version 1 entries contain `path`,
`byteLength`, `source`, `sha256` and optional `fingerprints`.

References are opaque identifiers, not URLs, credentials or storage authorization.
A caller-supplied `FileSource.open(reference)` returns a fresh scoped Effect stream.
`Source.fromPromise` adapts small promise readers and forwards an abort signal.
Text, bytes, directory and legacy deferred constructors remain available.

Canonical encoding sorts paths and fingerprint recipes and fixes field ordering.
Envelope identity includes source references and fingerprint metadata; it is distinct
from content identity. SHA-256 identifies raw content. Recognized upload recipes are:

| Adapter | Recipe                        | Context                               |
| ------- | ----------------------------- | ------------------------------------- |
| Vercel  | `vercel-sha1-v1`              | Empty string                          |
| Pages   | `cloudflare-blake3-b64ext-v1` | Destination extension without the dot |

A changed extension invalidates the Pages hint. Unknown recipes are ignored.
Readers verify declared size and raw integrity; uploads verify provider fingerprints.
A warm cache hit trusts the manifest producer and deliberately does not re-read bytes.
Legacy deferred fingerprints still work but have no independent raw SHA-256 identity.
Paths retain the existing conservative filesystem portability rules.

## Transfer limits and interruption

- At most 20,000 entries. Cloudflare static assets support up to 25 MiB; `_worker.js` retains its 8 MiB buffered limit.
- Both adapters stage static files above 8 MiB on disk and verify them before upload. Disk reads use 64 KiB chunks.
- The default staging policy allows 100,000,000 bytes per Vercel file and 256 MiB of concurrent temporary files. Cloudflare additionally enforces its 25 MiB asset limit.
- `stagingBudgetBytes` and `maxFileBytes` on the adapter layer (or `createClient`) change those local limits for every job it runs.
- Provider/account limits still apply. The staging policy is not a claim about Vercel's maximum accepted size.
- `memoryBudgetBytes` defaults to 256 MiB of memory reservations.
- Buffered files reserve `16 × raw size + 8 MiB`; staged transfers reserve 1 MiB through staging and upload.
- One `Deploykit` layer shares both budgets across all its jobs. Direct `DeploymentProvider` users pass `transferBudget` and `stagingBudget` themselves.
- Vercel processes eight files concurrently by default; Pages uploads at most four single-asset payloads.
- Disk reservations and temporary files live in an Effect scope and are released on success, failure or cancellation.
- Each HTTP retry reopens the verified staged file. An unknown fingerprint requires a separate hash pass before missing-file negotiation; that pass also cleans up its file.
- Staging requires a writable temporary directory and enough disk space. Process termination can leave temporary files; this is not durable resumability.
- Source reads and staging have a 30-second deadline; HTTP operations, including retry backoff, default to 30 seconds (`timeoutMs` config).
- Responses are capped at 2 MiB. Caller-wide deadlines can wrap operations with Effect timeout/interruption.

```typescript
const DeploykitLive = Vercel.layer({
  token,
  stagingBudgetBytes: 256 * 1024 * 1024,
  maxFileBytes: 100_000_000
})
```

Custom
Vercel clients need `uploadFileStream` and Cloudflare clients need `uploadAssetStream`
for large assets; otherwise preflight rejects them. Both built-in HTTP clients implement
these operations. Cloudflare encodes base64 incrementally inside a streamed JSON request
and computes its fingerprint incrementally over that encoding plus the extension.
Its [25 MiB static-asset limit](https://developers.cloudflare.com/pages/platform/limits/#file-size)
is enforced even when the local staging budget allows more.

Reservations constrain SDK transfer allocations, not total process RSS. Caller-owned
resident inputs, source implementation buffers, manifest/control metadata, runtime and GC
are additional memory. Sources must produce bounded chunks and honour interruption;
a promise reader can allocate memory before returning it, outside SDK control.
Cancellation forwards to reads and fetch, closes streams and releases reservations.
It cannot undo a request already accepted by a provider.

`BENCHMARKS.md` records the local synthetic methodology and measurements. These are not
provider latency measurements or a hard RSS guarantee.

## Failures and retries

`ProviderError` includes operation, available IDs/codes, outcome certainty and recovery
guidance. `SourceError`, `IntegrityError`, `ValidationError`, `TransferLimitError` and
`UnsupportedError` remain distinguishable. `Provider.encodeFailure/decodeFailure`
carry versioned failures across JSON boundaries. Defects and interruption remain separate.
Use `Effect.catchTag("ProviderError", ...)` to inspect provider codes and recovery
hints. A known Vercel password-protection rejection is `rejected` / `fix-input`;
it does not become an ambiguous create outcome or trigger automatic retries.
Provider response diagnostics retain only allowlisted codes and content hashes.

Read and content-addressed upload retries default to four attempts with backoff and
`Retry-After`. A 429 asking for 10 seconds or less does not use up an attempt: it is
retried until the request deadline, because the provider has said it did nothing and when
to return. Longer 429s go back to the caller with `retryAfterMs`. Set
`retry: { attempts: 1 }` on either HTTP client to disable all retries.
Vercel also honors `X-RateLimit-Reset` on HTTP 429 when `Retry-After` is absent,
including reads and uploads without a throttle preset. The request deadline still applies.
Create and activation writes are single-attempt, including throttling responses.
Vercel's missing-file negotiation is separate: up to three rejected-manifest upload rounds.
A lost or malformed create response is ambiguous, never permission to create again.

`Provider.recoveryOf(error)` (also exported by `@deploykit/node`) turns any of these into
one of `retry`, `reconcile`, `wait`, `fix-input` or `unsupported`.

Provider rate limits are per token, so processes sharing one token can only stay under
them together. Pass a `gate` to either HTTP client (or `createClient`): it is asked
before every request and told about every 429. Back it with Redis or similar; it fails
open if the store is down. Without a gate, each process paces only itself.

Progress callbacks are best-effort and bounded to 100 ms each. Upload `bytes` reports
acknowledged raw bytes for that batch, excluding cache hits and duplicate transport attempts.
Persist operation intent before calling, and persist returned deployment IDs. Progress is
not a receipt and interruption cannot guarantee a receipt reaches the caller.

## Capabilities and activation

| Behaviour                      | Vercel                                                                   | Pages                                                                                |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Automatic production deploy    | Implemented                                                              | Implemented                                                                          |
| Deferred production activation | Implemented; isolated same-deployment activation verified                | Unsupported, rejected before writes                                                  |
| Explicit preview               | Existing target option; first-deployment semantics require qualification | Requires configured `previewBranch`, checked against the project's production branch |
| Correlation recovery           | `operationId`, bounded metadata lookup                                   | Unsupported; explicit metadata/correlation requests fail before writes               |
| Access control                 | Public/password/SSO modes                                                | Not exposed by this adapter                                                          |
| List, rollback, delete         | Rollback promotes an older ready production deployment                   | Rollback uses the Pages rollback endpoint                                            |

Use `{ target: "production", activation: "deferred", operationId }` to stage a Vercel
deployment. After caller checks, call the optional control-plane `activateDeployment`
and observe `getActivation`. Activation requires a ready production deployment belonging
to the app. It does not rebuild a preview. Request acceptance returns `pending`; a separate
observation can establish `active`. Other routing states remain `unknown`.

Reconciliation returns `Recovered` only for one matching deployment in a complete search
window; zero/multiple matches and incomplete windows return `Unknown`. There is no
exactly-once, absence or resume promise. Activation may race another caller or alter
provider project settings; callers own serialization and approval policy. Access protection
and rolling-release configurations need further live qualification.

Control imports are `@deploykit/vercel/control` and `@deploykit/cloudflare/control`.
Both export their control factory, HTTP client factory, client/config types and API
error type, so coordinators do not need to import the transfer entry point.
`check:control` resolves and bundles their transitive imports for a browser target and
rejects external/dynamic imports and transfer modules. Keep full adapter and transfer
imports in the worker, not the coordinator.

## Deployment history

`listDeployments(appId, { target: "production" })` returns one page, newest first.
`rollback(appId, deploymentId)` points production back at an earlier successful production
deployment without rebuilding. `deleteDeployment` refuses the deployment serving production
on both providers. These are built from the published API docs and tested against fakes;
run `scripts/qualify.ts` (below) before relying on them.

## Testing code that deploys

`TestProvider.deploykitLayer()` from `@deploykit/test` gives code under test a `Deploykit`
over an in-memory provider, plus the `TestProvider` handle to inspect what was deployed.
Without Effect, `createTestClient()` from `@deploykit/node/test` is the same thing behind
Promises, with `snapshot()` and `artifactFor(deploymentId)`. Nothing leaves the process;
`failOn`, `neverFinish` and `lostCreateResponse` script the error paths.

## Runtimes without a filesystem

`@deploykit/node/edge` has `createVercelClient`, `createCloudflareClient` and in-memory
`artifactFromFiles` for runtimes such as Cloudflare Workers with `nodejs_compat` (it needs
`node:crypto` and `node:buffer`, nothing else from Node; `check:control` enforces that).
Deploy from bytes, text or manifests with fetched sources. Directories are unavailable and
files are capped at 8 MiB, since larger ones are staged on disk.

## Custom domains

Out of scope. Per-tenant domains (add, DNS records, verification, removal) are a separate
lifecycle that tools such as [Domain SDK](https://www.domain-sdk.dev/) already cover across
providers. Pass them deploykit's `app.id`: it is the Vercel project ID or Pages project name.

## Development and qualification

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run lint
bun run format:check
bun run check:control
bun run check:packages
bun run benchmark
```

CI runs local checks without provider credentials. Live smoke tooling requires explicit
isolated-account authorization plus `DEPLOYKIT_ISOLATED=1` and an explicit `CLEANUP=1`
(delete) or `CLEANUP=0` (keep for inspection). It creates a
`deploykit-smoke-*` project. `bun scripts/qualify.ts` (same flags, plus `PROVIDER`)
checks list, rollback and delete against a real `deploykit-qualify-*` project; add
`ACCESS_PROBE=1` for password protection and `RATE_PROBE=1` for a bounded burst of reads
that meets real 429s. Existing credentials alone are not authorization. New
activation, preview, cache, function and access claims must be qualified before release.
No package publishing is automated.

## License

MIT.

## Telemetry and local devtools

`@deploykit/core/telemetry` exposes a vendor-independent `Observer` Effect context
reference. Both adapters emit input counts, cache decisions, acknowledged upload
progress, nested operation timings, retry delays, deployment identifiers and
allowlisted failure diagnostics. `Telemetry.observe(provider, operation, effect)`
also creates an Effect span and lets callers include preparation or verification.
Installing an observer is optional; no analytics client or credentials are required.

```typescript
import { Effect } from "effect"
import * as Telemetry from "@deploykit/core/telemetry"

const observed = publish.pipe(
  Effect.provideService(Telemetry.Observer, event => Effect.sync(() => enqueueTelemetry(event)))
)
```

Use a bounded queue in the consumer. SDK observer calls are best effort, isolated
from deployment failures and limited to 10 ms; a synchronous blocking callback
cannot be preempted. Do not perform network exports inside this hook. Callers own
correlation across processes, durable delivery, sampling, backend selection and
exporter shutdown. Raw errors still reach the caller unchanged. Events omit raw
messages, stacks, response bodies, credentials, file paths and source references;
content fingerprints can be matched back to the caller's manifest. Apply your own
redaction policy to custom labels, operation names and any Effect tracing backend.

`@deploykit/devtools` adds a localhost dashboard and a bounded in-memory collector:

```typescript
import * as Devtools from "@deploykit/devtools"

const local = Effect.scoped(
  Effect.gen(function* () {
    const devtools = yield* Devtools.make({
      onEvent: event => exportTelemetry(event)
    })
    console.log(devtools.url)
    const result = yield* devtools.track(publish, {
      label: "Publish preview",
      correlationId: publishAttemptId
    })
    yield* devtools.flush
    return result
  })
)
```

The scope owns the server and exporter. Keep it open while inspecting the page;
closing it stops both. `makeCollector` supplies the same tracking API without an
HTTP server. Recorded events include schema version, run ID, caller correlation
ID, sequence, UTC timestamp and monotonic elapsed time. The exporter runs separately
with a 1,024-event queue and two-second per-event timeout. `flush` waits up to three
seconds and reports whether the queue drained, not whether delivery succeeded;
snapshots expose export failures, pending events and drops. It never retries exports.

The page retains 20 runs and the latest 500 events per run, with omission counters
and aggregate timings preserved independently. Timings show counts, cumulative,
mean and slowest operations; concurrent/nested durations must not be summed as
wall time. Upload counters describe the current negotiation batch and provider
acknowledgements, not network bytes in flight. RSS is for the entire local process,
not individual deployments. Byte-level throughput, staging-disk sampling, durable
history and remote dashboard hosting are not provided by this first package.

`track` observes your Effect; it neither polls readiness nor chooses retries or
activation. Wrap the whole caller pipeline if you want those stages included.
A successful tracked Effect is not itself proof of application health. Ambiguous
provider outcomes remain explicit. Telemetry cannot promise lossless delivery when
an exporter stalls or the process exits.

Run `bun run devtools` for a local demo with simulated activity and no provider calls.
The package includes no PostHog or other analytics-vendor integration.

Vercel callers can tune uploads with the exported `DeployRequestOptions` type:
`uploadConcurrency` accepts integers from 1 to 32 (default 8), and `uploadOrder`
accepts `"manifest"` (default) or `"largest-first"`. Pass a typed options variable
to `deploy` (or use `createClient` from `@deploykit/node/vercel`, which types them); these are Vercel adapter settings, not portable guarantees.
Both settings retain the existing memory/staging budgets and preserve manifest
paths and deployment contents. Higher concurrency may improve latency-bound
transfers but can increase resource use and rate limiting; measure it on your host.

Use `uploadThrottle` on `makeVercelClient` to share an upload limit across publishes
using that client. Every upload attempt, including retries, passes through it.

```typescript
const client = makeVercelClient({
  token,
  uploadThrottle: "balanced"
})
```

| Preset         | Concurrent HTTP uploads | Minimum start interval |
| -------------- | ----------------------- | ---------------------- |
| `conservative` | 4                       | 250 ms                 |
| `balanced`     | 8                       | 100 ms                 |
| `fast`         | 16                      | 0 ms                   |

Or supply `{ concurrency: 6, intervalMs: 150 }`. Concurrency accepts 1–32 and
spacing accepts 0–60,000 milliseconds. `uploadThrottlePresets` exports the values.
These are explicit caller policies, not discovered Vercel limits or guaranteed
throughput. Omission preserves the existing unpaced behaviour. The deployment's
`uploadConcurrency` and shared memory/disk budgets can impose lower limits; choosing
`fast` does not increase the default eight-file deployment worker pool.

With throttling enabled, an upload HTTP 429 pauses new upload attempts through the
same client using `Retry-After`, then `x-ratelimit-reset`, or a one-second fallback.
Requests already in flight finish normally. The retry policy still controls whether
the rejected upload retries; create and activation remain single-attempt.
`uploadThrottle.wait` spans expose pacing/cooldown time. Waiting counts toward the
HTTP operation deadline, and interruption releases permits.

Clients in different processes do not share limits. the consumer must coordinate
account-wide quotas across Fluid workers. The policy does not automatically raise
or lower concurrency, infer bandwidth, or replenish a daily upload quota.

Live trials at concurrency 16 reduced average total upload time by 7.5%, but the
largest 69.5 MB file took up to 41.7 seconds. Those trials set `timeoutMs: 120000`;
the default 30-second deadline would be insufficient for those requests. Tune
concurrency, pacing and deadlines together; see `BENCHMARKS.md` for limits of the
measurement.
