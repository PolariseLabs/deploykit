# @deploykit/node

Promise clients and streaming file helpers for Node and Bun. Import `createClient`
from `@deploykit/node/vercel` or `@deploykit/node/cloudflare`. File helpers are
exported from `@deploykit/node`. No Effect imports are required in your app.

Pass `signal` for cancellation and call `await client.close()` in `finally`.
Failures preserve their original tagged errors; cancellation cannot undo an
operation already accepted by a provider. Reconcile ambiguous creation outcomes.

Alpha API, version `0.1.0-alpha.1`. Node 22.19 or newer.
Effect integrations use exactly `effect@4.0.0-rc.112`; keep the runtime graph aligned.
