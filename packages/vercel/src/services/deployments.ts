import * as Telemetry from "@deploykit/core/telemetry"
import type { Entry } from "@deploykit/core/entry"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { FileSystem } from "effect"
import { Artifact, Provider } from "@deploykit/core"
import * as Transfer from "@deploykit/core/transfer"
import * as Staging from "@deploykit/core/staging"
import type { VercelClient } from "./client.js"
import { isMissingDigest, missingShas } from "./client.js"
import { toProviderError } from "./error.js"
import { toDeployment } from "./status.js"

export const bytesOf = (fs: FileSystem.FileSystem, entry: Entry) =>
  Effect.gen(function* () {
    const budget = yield* Transfer.makeBudget()
    return yield* Transfer.withBytes(budget, fs, entry, Effect.succeed)
  })
const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex")

export interface DeployRequestOptions extends Provider.DeployOptions {
  /** Missing-file negotiation rounds, independent of transport retries. */
  readonly uploadRounds?: number
  /** Parallel uploads still share the caller's memory and staging budgets. */
  readonly uploadConcurrency?: number
  readonly uploadOrder?: "manifest" | "largest-first"
}

export const deployToVercelProject = (
  vercel: VercelClient,
  fs: FileSystem.FileSystem,
  appId: string,
  artifact: Artifact.Artifact,
  options: DeployRequestOptions = {}
) =>
  Effect.gen(function* () {
    const uploadConcurrency = options.uploadConcurrency ?? 8
    const uploadOrder = options.uploadOrder ?? "manifest"
    if (!Number.isSafeInteger(uploadConcurrency) || uploadConcurrency < 1 || uploadConcurrency > 32)
      return yield* new Provider.ValidationError({
        message: "uploadConcurrency must be between 1 and 32"
      })
    if (uploadOrder !== "manifest" && uploadOrder !== "largest-first")
      return yield* new Provider.ValidationError({ message: "Invalid uploadOrder" })
    if (options.activation === "deferred" && options.target === "preview") {
      return yield* new Provider.UnsupportedError({
        provider: "vercel",
        capability: "preview-activation",
        message: "Only production deployments can be activated without rebuilding"
      })
    }
    if (options.operationId !== undefined && !/^[\w.-]{1,128}$/.test(options.operationId))
      return yield* new Provider.ValidationError({ message: "Invalid operationId" })
    const budget = options.transferBudget ?? (yield* Transfer.makeBudget())
    const entries = Artifact.list(artifact)
    yield* Telemetry.emit({
      kind: "input",
      provider: "vercel",
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + Artifact.sizeOf(entry), 0)
    })
    const staging = options.stagingBudget ?? (yield* Staging.makeStagingBudget())
    const large = (entry: Entry) => Artifact.sizeOf(entry) > 8 * 1024 * 1024
    yield* Transfer.validateEntries(entries, staging.maxFileBytes)
    yield* Transfer.validate(
      entries.filter(entry => !large(entry)),
      budget
    )
    if (entries.some(large)) {
      if (vercel.uploadFileStream === undefined)
        return yield* new Provider.UnsupportedError({
          provider: "vercel",
          capability: "streaming-upload",
          message: "This client does not support files above 8 MiB"
        })
      yield* budget.use(1024 * 1024, Effect.void)
    }
    const withStagedEntry = <A, E, R>(
      entry: Entry,
      use: (file: Staging.StagedFile) => Effect.Effect<A, E, R>
    ) =>
      budget.use(
        1024 * 1024,
        Effect.scoped(
          Telemetry.observe("core", "stage", Staging.stageEntry(fs, entry, staging), {
            bytes: Artifact.sizeOf(entry)
          }).pipe(Effect.flatMap(use))
        )
      )
    for (const entry of entries) {
      const known = Transfer.fingerprint(entry, "vercel-sha1-v1", "", "sha1")
      if (known !== undefined && !/^[a-f0-9]{40}$/.test(known))
        return yield* new Provider.ValidationError({ message: "Malformed provider fingerprint" })
    }
    const rounds = options.uploadRounds ?? 3
    if (!Number.isSafeInteger(rounds) || rounds < 0 || rounds > 10)
      return yield* new Provider.ValidationError({
        message: "uploadRounds must be between 0 and 10"
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
                  provider: "vercel",
                  stage: "created",
                  deploymentId: event.deploymentId
                }
              : {
                  kind: "progress",
                  provider: "vercel",
                  stage: event._tag === "Hashing" ? "hashing" : "uploading",
                  done: event.done,
                  total: event.total,
                  ...(event._tag === "Uploading" ? { bytes: event.bytes } : {})
                }
          )
        yield* reportCallback(event)
      })
    yield* report({ _tag: "Hashing", done: 0, total: entries.length })
    const files = yield* Effect.forEach(
      entries,
      entry =>
        Effect.gen(function* () {
          const known = Transfer.fingerprint(entry, "vercel-sha1-v1", "", "sha1")
          if (known !== undefined)
            return { file: entry.path, sha: known, size: Artifact.sizeOf(entry) }
          if (large(entry))
            return yield* withStagedEntry(entry, file =>
              Effect.succeed({ file: entry.path, sha: file.sha1, size: file.byteLength })
            )
          return yield* Transfer.withBytes(budget, fs, entry, bytes =>
            Effect.succeed({ file: entry.path, sha: sha1(bytes), size: bytes.byteLength })
          )
        }),
      { concurrency: 8 }
    )
    yield* report({ _tag: "Hashing", done: entries.length, total: entries.length })
    const bySha = new Map(files.map((file, index) => [file.sha, entries[index]!]))
    for (let round = 0; round <= rounds; round++) {
      const result = yield* vercel
        .createDeployment({
          projectId: appId,
          name: appId,
          files,
          target: options.target ?? "production",
          ...(options.activation === "deferred" ? { autoAssignCustomDomains: false } : {}),
          ...(options.meta !== undefined || options.operationId !== undefined
            ? {
                meta: {
                  ...options.meta,
                  ...(options.operationId === undefined
                    ? {}
                    : { deploykitOperationId: options.operationId })
                }
              }
            : {})
        })
        .pipe(Effect.result)
      if (result._tag === "Success") {
        if (round === 0)
          yield* Telemetry.emit({
            kind: "cache",
            provider: "vercel",
            totalContents: bySha.size,
            missingContents: 0,
            missingBytes: 0
          })
        const deployment = toDeployment(result.success, appId)
        yield* report({ _tag: "Created", deploymentId: deployment.id })
        yield* Telemetry.emit({
          kind: "deployment",
          provider: "vercel",
          id: deployment.id,
          status: deployment.status,
          ...(deployment.url === undefined ? {} : { url: deployment.url })
        })
        return deployment
      }
      const error = result.failure
      const missing =
        error.statusCode === 400
          ? (missingShas(error) ??
            (isMissingDigest(error) ? files.map(file => file.sha) : undefined))
          : undefined
      if (missing === undefined || round === rounds) return yield* toProviderError(error, { appId })
      const wanted = [...new Set(missing)]
      if (wanted.some(sha => !bySha.has(sha))) return yield* toProviderError(error, { appId })
      if (uploadOrder === "largest-first")
        wanted.sort((a, b) => Artifact.sizeOf(bySha.get(b)!) - Artifact.sizeOf(bySha.get(a)!))
      yield* Telemetry.emit({
        kind: "cache",
        provider: "vercel",
        totalContents: bySha.size,
        missingContents: wanted.length,
        missingBytes: wanted.reduce((sum, sha) => sum + Artifact.sizeOf(bySha.get(sha)!), 0)
      })
      yield* report({ _tag: "Uploading", done: 0, total: wanted.length, bytes: 0 })
      let uploaded = 0
      let uploadedBytes = 0
      yield* Effect.forEach(
        wanted,
        sha =>
          Telemetry.observe(
            "vercel",
            "transfer",
            Effect.suspend(() => {
              const entry = bySha.get(sha)!
              if (large(entry))
                return withStagedEntry(entry, file =>
                  Effect.gen(function* () {
                    yield* Transfer.checkFingerprint(entry.path, sha, file.sha1)
                    yield* vercel.uploadFileStream!(
                      sha,
                      file.byteLength,
                      Staging.openStagedBody(fs, file.path)
                    ).pipe(Effect.mapError(cause => toProviderError(cause, { appId })))
                  })
                )
              return Transfer.withBytes(budget, fs, entry, bytes =>
                Effect.gen(function* () {
                  yield* Transfer.checkFingerprint(entry.path, sha, sha1(bytes))
                  yield* vercel
                    .uploadFile(sha, bytes)
                    .pipe(Effect.mapError(cause => toProviderError(cause, { appId })))
                })
              )
            }),
            { contentId: sha, bytes: Artifact.sizeOf(bySha.get(sha)!) }
          ).pipe(
            Effect.tap(() => {
              uploaded++
              uploadedBytes += Artifact.sizeOf(bySha.get(sha)!)
              return report({
                _tag: "Uploading",
                done: uploaded,
                total: wanted.length,
                bytes: uploadedBytes
              })
            })
          ),
        { concurrency: uploadConcurrency }
      )
      yield* report({
        _tag: "Uploading",
        done: wanted.length,
        total: wanted.length,
        bytes: wanted.reduce((sum, sha) => sum + Artifact.sizeOf(bySha.get(sha)!), 0)
      })
    }
    return yield* new Provider.ProviderError({
      provider: "vercel",
      message: "Negotiation exhausted"
    })
  }).pipe(effect => Telemetry.observe("vercel", "deploy", effect))
