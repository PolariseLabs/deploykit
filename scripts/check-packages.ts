import { execFile } from "node:child_process"
import assert from "node:assert/strict"
import { promisify } from "node:util"
import { mkdtemp, writeFile, cp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { Effect, Schema } from "effect"

const exec = promisify(execFile)
const root = process.cwd()
const PackageMetadata = Schema.Struct({
  version: Schema.String,
  publishConfig: Schema.Struct({ access: Schema.String, tag: Schema.String }),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  exports: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))
})
const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.tryPromise(() => exec(command, [...args], { cwd, maxBuffer: 4 * 1024 * 1024 }))

const program = Effect.acquireUseRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "deploykit-pack-"))),
  directory =>
    Effect.gen(function* () {
      const dependencies: Record<string, string> = {
        effect: "4.0.0-rc.112",
        "@effect/platform-node": "4.0.0-rc.112",
        typescript: "5.9.3",
        "@types/node": "24.13.3"
      }
      for (const name of ["core", "vercel", "cloudflare", "test", "devtools", "node"]) {
        const filename = join(directory, `${name}.tgz`)
        yield* run(
          "bun",
          ["pm", "pack", "--ignore-scripts", "--filename", filename],
          resolve(root, "packages", name)
        )
        const listing = yield* run("tar", ["-tzf", filename], directory)
        const files = listing.stdout.trim().split("\n")
        assert.ok(files.includes("package/LICENSE"), `${name}: missing license`)
        assert.ok(
          files.every(file => /^package\/(dist\/|package\.json$|LICENSE$|README\.md$)/.test(file)),
          `${name}: unexpected packed files`
        )
        const metadata = yield* run("tar", ["-xOf", filename, "package/package.json"], directory)
        const packed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageMetadata))(
          metadata.stdout
        )
        assert.equal(packed.version, "0.1.0-alpha.1")
        assert.deepEqual(packed.publishConfig, { access: "public", tag: "alpha" })
        for (const value of Object.values(packed.dependencies ?? {})) {
          assert.ok(typeof value === "string" && !value.startsWith("workspace:"))
        }
        // Effect apps must share one Effect instance with deploykit; only the
        // Promise package, whose users never see Effect, bundles its own.
        const effectIsPeer = packed.peerDependencies?.effect !== undefined
        assert.equal(effectIsPeer, name !== "node", `${name}: effect dependency kind`)
        assert.equal(packed.dependencies?.effect !== undefined, name === "node")
        for (const entry of Object.values(packed.exports ?? {})) {
          assert.ok(typeof entry === "object" && entry !== null)
          for (const target of Object.values(entry)) {
            assert.ok(typeof target === "string" && files.includes(`package/${target.slice(2)}`))
          }
        }
        dependencies[`@deploykit/${name}`] = `file:${filename}`
      }
      yield* Effect.tryPromise(() =>
        writeFile(
          join(directory, "package.json"),
          JSON.stringify({
            private: true,
            type: "module",
            dependencies,
            overrides: { "@effect/platform-node-shared": "4.0.0-rc.112" }
          })
        )
      )
      yield* run(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"],
        directory
      )
      yield* Effect.tryPromise(() =>
        cp(resolve(root, "examples"), join(directory, "examples"), { recursive: true })
      )
      yield* Effect.tryPromise(() =>
        writeFile(
          join(directory, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              strict: true,
              noEmit: true,
              allowImportingTsExtensions: true,
              skipLibCheck: false
            },
            include: ["examples/**/*.ts"]
          })
        )
      )
      yield* run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], directory)
      for (const runtime of ["node", "bun"]) {
        const result = yield* run(runtime, ["examples/packed-proof.ts"], directory)
        console.log(`${runtime}: ${result.stdout.trim()}`)
        const promise = yield* run(runtime, ["examples/promise-proof.ts"], directory)
        console.log(`${runtime}: ${promise.stdout.trim()}`)
        const devtools = yield* run(runtime, ["examples/devtools-proof.ts"], directory)
        console.log(`${runtime}: ${devtools.stdout.trim()}`)
      }
    }),
  directory => Effect.promise(() => rm(directory, { recursive: true, force: true }))
)

await Effect.runPromise(program)
