import { createHash } from "node:crypto"
import { Effect, Layer, Stream } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Artifact, Manifest, Provider } from "@deploykit/core"
import { makeBudget } from "@deploykit/core/transfer"
import { layerWith as vercelLayer } from "@deploykit/vercel"
import type { VercelClient } from "@deploykit/vercel"
import { VercelApiError } from "@deploykit/vercel"
import { layerWith as pagesLayer, pagesDigest } from "@deploykit/cloudflare"
import type { CloudflareClient } from "@deploykit/cloudflare"

const program = Effect.gen(function* () {
  const budget = yield* makeBudget(160 * 1024 * 1024, 8 * 1024 * 1024)
  for (const provider of ["vercel", "cloudflare"] as const) {
    for (const [count, size, jobs] of [
      [100, 65536, 1],
      [16, 4 * 1024 * 1024, 4]
    ]) {
      const bytesOf = (index: number) => {
        const bytes = new Uint8Array(size!)
        new DataView(bytes.buffer).setUint32(0, index)
        return bytes
      }
      const entries = Array.from({ length: count! }, (_, index) => {
        const bytes = bytesOf(index)
        return {
          path: `${index}.bin`,
          source: String(index),
          byteLength: size!,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          fingerprints: [
            {
              recipe: provider === "vercel" ? "vercel-sha1-v1" : "cloudflare-blake3-b64ext-v1",
              context: provider === "vercel" ? "" : "bin",
              value:
                provider === "vercel"
                  ? createHash("sha1").update(bytes).digest("hex")
                  : pagesDigest(bytes, `${index}.bin`)
            }
          ]
        }
      })
      for (const warm of [false, true]) {
        const cached = new Set(warm ? entries.map(entry => entry.fingerprints[0]!.value) : [])
        let reads = 0
        let uploaded = 0
        const artifact = yield* Manifest.toArtifact(
          { version: 1, entries },
          {
            open: reference =>
              Stream.fromEffect(
                Effect.sync(() => {
                  reads++
                  return bytesOf(Number(reference))
                })
              )
          }
        )
        const vercel: VercelClient = {
          createProject: name => Effect.succeed({ id: name, name }),
          getProject: name => Effect.succeed({ id: name, name }),
          deleteProject: () => Effect.void,
          setProjectAccess: () => Effect.void,
          getDeployment: () => Effect.succeed({ id: "d", readyState: "READY" }),
          uploadFile: (sha, bytes) =>
            Effect.sleep("1 millis").pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  uploaded += bytes.length
                  cached.add(sha)
                })
              )
            ),
          createDeployment: request =>
            Effect.suspend(() => {
              const missing = request.files
                .filter(file => !cached.has(file.sha))
                .map(file => file.sha)
              return missing.length === 0
                ? Effect.succeed({ id: "d", readyState: "READY" as const })
                : Effect.fail(
                    new VercelApiError({
                      operation: "createDeployment",
                      message: "Missing files",
                      statusCode: 400,
                      body: JSON.stringify({ error: { missing } })
                    })
                  )
            })
        }
        const pages: CloudflareClient = {
          createProject: name => Effect.succeed({ id: name, name }),
          getProject: name => Effect.succeed({ id: name, name }),
          deleteProject: () => Effect.void,
          getDeployment: () =>
            Effect.succeed({ id: "d", latest_stage: { name: "deploy", status: "success" } }),
          uploadToken: () => Effect.succeed("test"),
          checkMissing: (_jwt, hashes) =>
            Effect.sync(() => hashes.filter(hash => !cached.has(hash))),
          upsertHashes: () => Effect.void,
          uploadAssets: (_jwt, payload) =>
            Effect.sleep("1 millis").pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  uploaded += payload.reduce(
                    (sum, item) => sum + Buffer.byteLength(item.value, "base64"),
                    0
                  )
                  payload.forEach(item => cached.add(item.key))
                })
              )
            ),
          createDeployment: () =>
            Effect.succeed({ id: "d", latest_stage: { name: "deploy", status: "success" } })
        }
        const layer = (provider === "vercel" ? vercelLayer(vercel) : pagesLayer(pages)).pipe(
          Layer.provide(NodeFileSystem.layer)
        )
        const startRss = process.memoryUsage().rss
        let peakRss = startRss
        const timer = setInterval(() => {
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
        }, 5)
        const start = performance.now()
        yield* Effect.all(
          Array.from({ length: jobs! }, () =>
            Effect.flatMap(Provider.DeploymentProvider, service =>
              service.deploy("app", artifact, { transferBudget: budget })
            )
          ),
          { concurrency: "unbounded" }
        ).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => clearInterval(timer))))
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
        console.log(
          JSON.stringify({
            provider,
            warm,
            files: Artifact.fileCount(artifact),
            bytes: Artifact.totalSize(artifact),
            jobs,
            requestConcurrency: provider === "vercel" ? 8 : 4,
            budgetBytes: budget.capacity,
            elapsedMs: Math.round(performance.now() - start),
            reads,
            uploadedBytes: uploaded,
            startRss,
            peakRss
          })
        )
      }
    }
  }
})

await Effect.runPromise(program)
