# deploykit

Add app deployment to your SaaS with one TypeScript API.

`deploykit` is a provider-agnostic deployment SDK for SaaS products that create, assemble or
generate applications on behalf of their users. Instead of building against Vercel, Netlify or
Cloudflare directly, you build against a small portable deployment model and supply a provider
adapter.

Built with [Effect](https://effect.website/).

## Status

Pre-v0.1. Nothing works yet. The scaffold exists; the domain is being written.

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
  const platform = yield* Platform

  const app = yield* platform.apps.getOrCreate({
    externalId: "customer-123",
    name: "customer-123"
  })

  const artifact = yield* Artifact.fromDirectory("./dist")

  return yield* app.deploy({ artifact })
})
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

| Package             | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `@deploykit/core`   | Portable domain: Artifact, App, Deployment, capabilities, errors |
| `@deploykit/vercel` | Vercel adapter (first real adapter, dogfood target)              |
| `@deploykit/test`   | In-memory provider for deterministic tests                       |

Cloudflare and Netlify adapters come after core survives the first two providers.

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

Milestones live in Notion. In short: Artifact first, then the provider contract and a test provider,
then the Vercel adapter, then the portable `Platform` API, then Cloudflare to attack the abstraction.

The rule when Cloudflare feels unnatural: change core. Do not add adapter hacks to preserve a
Vercel-shaped API.

## License

MIT
