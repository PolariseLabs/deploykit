# @deploykit/cloudflare

Cloudflare Pages adapter for deploykit. `layer` accepts credentials and supplies
the shared Effect service; `layerConfig` reads environment configuration. The
`/control` entry provides lightweight management operations. Provider capabilities
differ from Vercel; deferred activation is unsupported.
For Promise clients, use `@deploykit/node/cloudflare`.

Alpha API, version `0.1.0-alpha.1`. Node 22.19 or newer.
Effect integrations use exactly `effect@4.0.0-rc.112`; keep the runtime graph aligned.
