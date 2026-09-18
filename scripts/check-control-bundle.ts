/**
 * Prove the control-plane entry point stays light.
 *
 * The split is only worth anything if importing it does not drag the deploy
 * path in behind it. A type-level split does not do that on its own: one
 * stray import re-attaches the whole graph, and nothing would fail.
 *
 * So walk the built module graph from dist/control.js and fail if anything
 * Node-only, or any module belonging to the deploy path, is reachable.
 */

import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"

const ENTRIES = ["packages/vercel/dist/control.js", "packages/cloudflare/dist/control.js"]

/** Unavailable in Convex's V8 runtime, so reachability here is a regression. */
const FORBIDDEN_BUILTINS = ["node:crypto", "node:fs", "node:path", "node:buffer"]
/** The byte-moving half. Reachable from control means the split has collapsed. */
const FORBIDDEN_MODULES = ["deployments.js", "fromDirectory.js", "digest.js"]

const imported = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map(match => match[1]!)

const walk = (entry: string): { files: Set<string>; external: Set<string> } => {
  const files = new Set<string>()
  const external = new Set<string>()
  const queue = [resolve(entry)]

  while (queue.length > 0) {
    const file = queue.pop()!
    if (files.has(file) || !existsSync(file)) continue
    files.add(file)

    for (const specifier of imported(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier))
      } else if (specifier.startsWith("@deploykit/")) {
        // Follow into the workspace: importing the core barrel would drag the
        // whole artifact module in, which is the mistake this exists to catch.
        const [, name, ...rest] = specifier.split("/")
        const sub = rest.length === 0 ? "index.js" : `${rest.join("/")}/index.js`
        queue.push(resolve(`packages/${name}/dist/${sub}`))
      } else {
        external.add(specifier)
      }
    }
  }

  return { files, external }
}

let failed = false

for (const entry of ENTRIES) {
  if (!existsSync(entry)) {
    console.error(`${entry} is not built. Run: bun run build`)
    process.exit(1)
  }

  const { files, external } = walk(entry)
  const builtins = FORBIDDEN_BUILTINS.filter(name => external.has(name))
  const modules = FORBIDDEN_MODULES.filter(name =>
    [...files].some(file => file.endsWith(`/${name}`))
  )

  const externals = [...external].sort().join(", ") || "(none)"
  console.log(`${entry}: ${files.size} local modules, external ${externals}`)

  for (const name of builtins) {
    console.error(`  FAIL reachable Node builtin: ${name}`)
    failed = true
  }
  for (const name of modules) {
    console.error(`  FAIL reachable deploy-path module: ${name}`)
    failed = true
  }
}

if (failed) process.exit(1)
console.log("ok: no Node builtins and no deploy-path modules reachable")
