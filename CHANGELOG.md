# Changelog

## 0.1.0-alpha.1 (release candidate)

Initial public alpha release candidate. APIs may change before a stable release.

- Effect-native deployment services with Vercel and Cloudflare Pages adapters.
- Promise clients for Node/Bun, plus an edge entry point for compatible runtimes
  without a filesystem, with an 8 MiB per-file limit.
- Serializable manifests, replayable sources, integrity checks, shared memory/disk
  budgets, cancellation and provider cache negotiation.
- Typed failures, safe-operation retries, reconciliation and explicit Vercel activation.
- Deployment waiting, listing, deletion and provider-specific rollback operations.
- Upload throttling and a caller-supplied request gate for shared rate coordination.
- Structured telemetry, a local devtools dashboard and an in-memory test provider.
- Installation guides, checked examples and generated public API references.

### Compatibility and limitations

Requires Node 22.19 or newer for the Node clients. Effect integrations use exactly
`4.0.0-rc.112`. All six packages share the same alpha version and publish under the
`alpha` distribution tag. APIs may change during alpha.

Providers retain different deployment, activation, access and file-size semantics.
Creation can have an ambiguous outcome and is not guaranteed exactly once. Consumers
own artifact composition/storage, durable scheduling and application verification.

Local adapter and packed-consumer checks complement isolated live qualification;
these do not establish production readiness for every account, runtime or workload.
Password protection and rolling releases still require an eligible Vercel plan for
qualification. Deliberate live rate-limit exhaustion is not a release requirement.
