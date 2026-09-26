# Deploykit documentation

Install and build from this directory:

```sh
bun install --frozen-lockfile
DEPLOYKIT_DOCS_URL=https://your-docs-domain.example bun run build
bun run start
```

Set `DEPLOYKIT_DOCS_URL` to the public HTTPS origin in the hosting environment before
building. It controls canonical links, sitemap and RSS URLs. Local development can
omit it; the build then uses relative URLs and reports a warning.

Fumapress selects the Vercel adapter when building on Vercel. For another host,
use its supported adapter in `vite.config.ts`; the default is a Node server.
Only deploy the docs application, never the repository's fixture or env files.

## Editing documentation

Write complete guide modules in `examples/docs/`, then embed them with an
`{/* example: examples/docs/name.ts */}` marker followed by a TypeScript fence.
From the repository root, run `bun run docs:sync` after changing an example or public API.
It updates embedded examples and the six package references from built declarations.
Do not hand-edit `content/docs/reference/api/*.mdx`.

`bun run check:docs` detects stale pages. `bun run typecheck` checks example modules;
`bun run check:packages` also runs the guide proof against packed packages on Node and Bun.
The proof uses offline HTTP transports and does not create live deployments.
Use `bun run types:check` and `bun run build` in this directory to check MDX and rendering.
