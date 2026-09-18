# deploykit

Add app deployment to your SaaS with one TypeScript API.

`deploykit` is a provider-agnostic deployment SDK for SaaS products that create, assemble or
generate applications on behalf of their users. Instead of building against Vercel, Netlify or
Cloudflare directly, you build against a small portable deployment model and supply a provider
adapter.

Built with [Effect](https://effect.website/).

## Status

Pre-v0.1, and working. Vercel and Cloudflare Pages both deploy end to end,
verified against real accounts: an artifact uploads, deploys, and serves
content byte-identical to what was sent. The API will still move.

## What is verified, and how

Both adapters have deployed to a real account and served content byte-identical
to what was sent: Vercel with a serverless function, Cloudflare Pages with a
Function. The test suite is thorough and mutation-checked, and it could not have
told you any of the following.

Four bugs were reachable only by making a real call:

- `@vercel/sdk` cannot express a prebuilt deployment at all. Every deploy was
  being submitted as source for Vercel to build.
- Its `uploadFile` misnames the digest header, so every upload fails with
  `invalid_digest`. The adapter was calling exactly that method.
- A team with deployment protection on by default makes every created project
  unreachable by its intended audience.
- Cloudflare reports its own internal failures as HTTP 200 with
  `success: false`, so classifying retryability by status code never retried
  them.

And three things that were reasoned through, typechecked, tested and wrong:

- `_worker.js` uploaded through the asset manifest deploys successfully and does
  nothing. The route falls through to `index.html`, with no error anywhere.
- `resume` was built on the assumption that naming a deployment continues it.
  It creates a second one, so an option meant to prevent duplication caused it.
  Removed.
- A terminal deployment status does not mean the URL answers. Vercel serves
  about 0.4s later, Cloudflare Pages about two minutes, and a fresh `pages.dev`
  subdomain fails DNS and then TLS before it starts returning 404s.

The lesson is not that the tests are bad. It is that a stub can only prove the
code does what its author believed the provider wanted. `scripts/smoke.ts` does
one real round trip against either provider and compares what is served against
what was uploaded; it is worth running before trusting a change to an adapter.

## The idea

```
SaaS product
    |
    v
deploykit
    |
    +-- Vercel
    +-- Netlify
    +-- Cloudflare
    +-- future providers
```

The target experience: provider-neutral business logic, with the provider chosen by the Layer you
supply rather than by rewriting deployment code.

```typescript
const program = Effect.gen(function* () {
  const platform = yield* Platform.Platform

  const app = yield* platform.apps.getOrCreate({
    externalId: "customer-123",
    name: "customer-123"
  })

  const artifact = yield* Artifact.fromDirectory("./dist")
  const started = yield* platform.deploy(app, { artifact, target: "production" })

  return yield* platform.deployments.waitUntilReady(app.id, started.id)
})
```

`App` is plain data rather than a handle, so it can be stored and read back;
deploying is a call on the platform, not a method on the app.

Swapping the provider is swapping the Layer, and nothing above it changes:

```typescript
program.pipe(Effect.provide(vercelLayer)) // or cloudflareLayer
```

A terminal status is not the same as a URL that answers. Vercel serves about
0.4s after reporting ready, Cloudflare Pages about two minutes, so confirming
that is a separate, opt-in step:

```typescript
yield * Platform.waitUntilServing(deployment.url)
```

## Principles

- **Artifact-first.** Prebuilt files are a first-class deployment source. Git is not required.
- **SaaS-first.** Optimised for software that creates and manages apps for its own users.
- **Provider-independent core.** Provider concepts stay inside adapters. Core imports no provider SDK.
- **Capabilities over pretending.** If a provider cannot do something, say so rather than inventing
  fake portability.
- **Escape hatches.** The underlying provider client stays reachable for advanced work.
- **Typed failures are public API.** Errors are part of the design, not an afterthought.
- **App is the stable resource.** Deployments are revisions of it. Provider IDs are metadata, not identity.

## Non-goals

- A Terraform replacement or general cloud infrastructure provisioning.
- Kubernetes or container orchestration.
- Traditional Git-based CI/CD with no embedded SaaS use case.
- Running application workloads. deploykit orchestrates hosting-provider APIs, nothing more.
- A lowest-common-denominator API. Optional features go behind capability checks.
- Support for twenty providers. Three trustworthy adapters beat twenty poor ones.

## Packages

| Package                 | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `@deploykit/core`       | Portable domain: Artifact, App, Deployment, capabilities, errors |
| `@deploykit/vercel`     | Vercel adapter (first real adapter, dogfood target)              |
| `@deploykit/cloudflare` | Cloudflare Pages adapter                                         |
| `@deploykit/test`       | In-memory provider and app store, for deterministic tests        |

Netlify comes after core survives the first two providers. Domains are deliberately out of
scope: `@opencoredev/domain-sdk` already covers five providers.

## Development

```bash
bun install
bun run typecheck
bun run test
bun run lint
bun run format
```

Effect is pinned to `4.0.0-rc.112`. Expect API churn until v4 is stable; bump deliberately, not
automatically.

## Roadmap

Artifact, the provider contract, a test provider, the Vercel adapter, the portable `Platform` API
and Cloudflare are all done. Cloudflare did its job: it changed core in four places rather than
being bent to fit.

- `getDeployment` takes the app as well as the deployment, because Pages has no endpoint for a
  deployment id on its own.
- Digests are keyed by algorithm, because Pages hashes blake3 over base64-plus-extension where
  Vercel wants sha1 of the bytes.
- A capability a provider lacks raises `UnsupportedError`, rather than failing somewhere deeper.
- `isTransient` can be overridden by an adapter, because Cloudflare reports its own internal
  errors as HTTP 200.

What `DeploymentStatus` did not need was a fifth value: Cloudflare reports a stage and a status,
five by five, and all twenty-five map onto the same four.

Still open: Pages Functions, the `composeKit` extraction on the consumer side, and a third
provider to test the abstraction again.

The rule stands. When a provider feels unnatural: change core. Do not add adapter hacks to
preserve one provider's shape.

## License

MIT
