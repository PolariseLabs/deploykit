import * as Telemetry from "@deploykit/core/telemetry"
import { Buffer } from "node:buffer"
import { Effect } from "effect"
import type { FileSystem } from "effect"
import { Artifact, Provider } from "@deploykit/core"
import type { Entry } from "@deploykit/core/entry"
import * as Staging from "@deploykit/core/staging"
import { assetBody, streamedDigest } from "./streaming.js"
import * as Transfer from "@deploykit/core/transfer"
import { CLOUDFLARE_DIGEST, extensionOf, pagesDigest } from "./digest.js"
import { toDeployment } from "./status.js"
import { WORKER_PATH, workerBundle } from "./worker.js"
import { toProviderError } from "./error.js"
import type { CloudflareClient } from "./client.js"

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  woff2: "font/woff2",
  wasm: "application/wasm"
}

export const deployToPagesProject = (
  cloudflare: CloudflareClient,
  fs: FileSystem.FileSystem,
  projectName: string,
  artifact: Artifact.Artifact,
  options: Provider.DeployOptions = {}
) =>
  Effect.gen(function* () {
    if (
      options.activation === "deferred" ||
      options.operationId !== undefined ||
      options.meta !== undefined
    ) {
      return yield* new Provider.UnsupportedError({
        provider: "cloudflare",
        capability: "deployment-options",
        message: "This adapter supports automatic deployment without correlation metadata only"
      })
    }
    const budget = options.transferBudget ?? (yield* Transfer.makeBudget())
    const all = Artifact.list(artifact)
    const staging = options.stagingBudget ?? (yield* Staging.makeStagingBudget())
    const largeAsset = (entry: Entry) =>
      entry.path !== WORKER_PATH && Artifact.sizeOf(entry) > 8 * 1024 * 1024
    yield* Transfer.validateEntries(all, Math.min(25 * 1024 * 1024, staging.maxFileBytes))
    yield* Transfer.validate(
      all.filter(entry => !largeAsset(entry)),
      budget
    )
    if (all.some(largeAsset)) {
      if (cloudflare.uploadAssetStream === undefined)
        return yield* new Provider.UnsupportedError({
          provider: "cloudflare",
          capability: "streaming-upload",
          message: "This client does not support assets above 8 MiB"
        })
      yield* budget.use(1024 * 1024, Effect.void)
    }
    const withStagedAsset = <A, E, R>(
      entry: Entry,
      use: (file: Staging.StagedFile, hash: string) => Effect.Effect<A, E, R>
    ) =>
      budget.use(
        1024 * 1024,
        Effect.scoped(
          Effect.gen(function* () {
            const file = yield* Telemetry.observe(
              "core",
              "stage",
              Staging.stageEntry(fs, entry, staging),
              { bytes: Artifact.sizeOf(entry) }
            )
            const hash = yield* streamedDigest(
              fs.stream(file.path, { chunkSize: 65536 }),
              entry.path
            ).pipe(
              Effect.timeout("30 seconds"),
              Effect.mapError(
                () =>
                  new Provider.SourceError({
                    reference: entry.path,
                    message: "Staged asset hashing failed"
                  })
              )
            )
            return yield* use(file, hash)
          })
        )
      )
    for (const entry of all) {
      const known = Transfer.fingerprint(
        entry,
        "cloudflare-blake3-b64ext-v1",
        extensionOf(entry.path),
        CLOUDFLARE_DIGEST
      )
      if (known !== undefined && !/^[a-f0-9]{32}$/.test(known))
        return yield* new Provider.ValidationError({ message: "Malformed provider fingerprint" })
    }
    let branch: string | undefined
    if (options.target === "preview") {
      branch = cloudflare.previewBranch
      if (branch === undefined || branch.length === 0)
        return yield* new Provider.UnsupportedError({
          provider: "cloudflare",
          capability: "preview",
          message: "Configure a non-production previewBranch"
        })
      const project = yield* cloudflare.getProject(projectName)
      if (project.production_branch === undefined || branch === project.production_branch)
        return yield* new Provider.UnsupportedError({
          provider: "cloudflare",
          capability: "preview",
          message: "Cannot establish a non-production branch"
        })
    }
    const extras = branch === undefined ? {} : { branch }
    const worker = all.find(entry => entry.path === WORKER_PATH)
    const entries = all.filter(entry => entry.path !== WORKER_PATH)
    yield* Telemetry.emit({
      kind: "input",
      provider: "cloudflare",
      files: all.length,
      bytes: all.reduce((sum, entry) => sum + Artifact.sizeOf(entry), 0)
    })
    const reportCallback = (event: Provider.DeployProgress) =>
      options.onProgress === undefined
        ? Effect.void
        : Effect.suspend(() => options.onProgress!(event)).pipe(
            Effect.timeoutOption("100 millis"),
            Effect.asVoid,
            Effect.catchCause(() => Effect.void)
          )
    const report = (event: Provider.DeployProgress) =>
      Effect.gen(function* () {
        if (event._tag !== "Throttled")
          yield* Telemetry.emit(
            event._tag === "Created"
              ? {
                  kind: "progress",
                  provider: "cloudflare",
                  stage: "created",
                  deploymentId: event.deploymentId
                }
              : {
                  kind: "progress",
                  provider: "cloudflare",
                  stage: event._tag === "Hashing" ? "hashing" : "uploading",
                  done: event.done,
                  total: event.total,
                  ...(event._tag === "Uploading" ? { bytes: event.bytes } : {})
                }
          )
        yield* reportCallback(event)
      })
    yield* report({ _tag: "Hashing", done: 0, total: entries.length })
    const hashed = yield* Effect.forEach(
      entries,
      entry => {
        const known = Transfer.fingerprint(
          entry,
          "cloudflare-blake3-b64ext-v1",
          extensionOf(entry.path),
          CLOUDFLARE_DIGEST
        )
        if (known !== undefined) return Effect.succeed({ entry, hash: known })
        if (largeAsset(entry))
          return withStagedAsset(entry, (_file, hash) => Effect.succeed({ entry, hash }))
        return Transfer.withBytes(budget, fs, entry, bytes =>
          Effect.succeed({ entry, hash: pagesDigest(bytes, entry.path) })
        )
      },
      { concurrency: 8 }
    )
    yield* report({ _tag: "Hashing", done: entries.length, total: entries.length })
    const jwt = yield* cloudflare.uploadToken(projectName)
    const missing = new Set(
      yield* cloudflare.checkMissing(jwt, [...new Set(hashed.map(file => file.hash))])
    )
    const unique = new Map(hashed.map(file => [file.hash, file]))
    const wanted = [...unique.values()].filter(file => missing.has(file.hash))
    yield* Telemetry.emit({
      kind: "cache",
      provider: "cloudflare",
      totalContents: unique.size,
      missingContents: wanted.length,
      missingBytes: wanted.reduce((sum, file) => sum + Artifact.sizeOf(file.entry), 0)
    })
    if (wanted.length > 0) {
      yield* report({ _tag: "Uploading", done: 0, total: wanted.length, bytes: 0 })
      let uploaded = 0
      let uploadedBytes = 0
      // One bounded asset per request avoids retaining the entire encoded tree.
      yield* Effect.forEach(
        wanted,
        file =>
          Telemetry.observe(
            "cloudflare",
            "transfer",
            Effect.suspend(() => {
              if (largeAsset(file.entry))
                return withStagedAsset(file.entry, (staged, hash) =>
                  Effect.gen(function* () {
                    yield* Transfer.checkFingerprint(file.entry.path, file.hash, hash)
                    const body = assetBody(
                      fs,
                      staged,
                      hash,
                      CONTENT_TYPES[extensionOf(file.entry.path).toLowerCase()] ??
                        "application/octet-stream"
                    )
                    yield* cloudflare.uploadAssetStream!(jwt, body.byteLength, body.open)
                  })
                )
              return Transfer.withBytes(budget, fs, file.entry, bytes =>
                Effect.gen(function* () {
                  yield* Transfer.checkFingerprint(
                    file.entry.path,
                    file.hash,
                    pagesDigest(bytes, file.entry.path)
                  )
                  yield* cloudflare.uploadAssets(jwt, [
                    {
                      key: file.hash,
                      value: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
                        "base64"
                      ),
                      metadata: {
                        contentType:
                          CONTENT_TYPES[extensionOf(file.entry.path).toLowerCase()] ??
                          "application/octet-stream"
                      },
                      base64: true
                    }
                  ])
                })
              )
            }),
            { contentId: file.hash, bytes: Artifact.sizeOf(file.entry) }
          ).pipe(
            Effect.tap(() => {
              uploaded++
              uploadedBytes += Artifact.sizeOf(file.entry)
              return report({
                _tag: "Uploading",
                done: uploaded,
                total: wanted.length,
                bytes: uploadedBytes
              })
            })
          ),
        { concurrency: 4 }
      )
      yield* report({
        _tag: "Uploading",
        done: wanted.length,
        total: wanted.length,
        bytes: wanted.reduce((sum, file) => sum + Artifact.sizeOf(file.entry), 0)
      })
      yield* cloudflare
        .upsertHashes(
          jwt,
          wanted.map(file => file.hash)
        )
        .pipe(Effect.catchTag("CloudflareApiError", () => Effect.void))
    }
    const manifest = Object.fromEntries(hashed.map(file => [`/${file.entry.path}`, file.hash]))
    const created =
      worker === undefined
        ? cloudflare.createDeployment(projectName, manifest, extras)
        : Transfer.withBytes(budget, fs, worker, bytes =>
            Effect.gen(function* () {
              const bundle = yield* Effect.tryPromise({
                try: () =>
                  workerBundle({
                    main: { name: "index.js", content: new TextDecoder().decode(bytes) }
                  }),
                catch: () =>
                  new Provider.SourceError({
                    reference: worker.path,
                    message: "Worker assembly failed"
                  })
              })
              return yield* cloudflare.createDeployment(projectName, manifest, {
                ...extras,
                workerBundle: bundle
              })
            })
          )
    const deployment = toDeployment(yield* created, projectName)
    yield* report({ _tag: "Created", deploymentId: deployment.id })
    yield* Telemetry.emit({
      kind: "deployment",
      provider: "cloudflare",
      id: deployment.id,
      status: deployment.status,
      ...(deployment.url === undefined ? {} : { url: deployment.url })
    })
    return deployment
  }).pipe(
    Effect.catchTag("CloudflareApiError", cause => toProviderError(cause, { appId: projectName })),
    effect => Telemetry.observe("cloudflare", "deploy", effect)
  )
