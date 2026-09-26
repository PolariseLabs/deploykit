import { Buffer } from "node:buffer"
import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { Effect, Stream } from "effect"
import type { FileSystem } from "effect"
import { openStreamBody } from "@deploykit/core/staging"
import type { StagedFile } from "@deploykit/core/staging"
import { extensionOf } from "./digest.js"

/** Carry at most two bytes so padding only appears at the end of the stream. */
export const encodeBase64 = <E, R>(source: Stream.Stream<Uint8Array, E, R>) =>
  Stream.suspend(() => {
    let carry = Buffer.alloc(0)
    const encoded = source.pipe(
      Stream.map(chunk => {
        const bytes = Buffer.concat([carry, chunk])
        const end = bytes.length - (bytes.length % 3)
        carry = Buffer.from(bytes.subarray(end))
        return bytes.subarray(0, end).toString("base64")
      })
    )
    return encoded.pipe(
      Stream.concat(Stream.suspend(() => Stream.succeed(carry.toString("base64"))))
    )
  })

export const streamedDigest = <E, R>(source: Stream.Stream<Uint8Array, E, R>, path: string) =>
  Effect.gen(function* () {
    const digest = blake3.create()
    const encoder = new TextEncoder()
    yield* encodeBase64(source).pipe(
      Stream.runForEach(text =>
        Effect.sync(() => {
          digest.update(encoder.encode(text))
        })
      )
    )
    digest.update(encoder.encode(extensionOf(path)))
    return bytesToHex(digest.digest()).slice(0, 32)
  })

/** Only the base64 value streams; JSON.stringify escapes the small metadata fields. */
export const assetBody = (
  fs: FileSystem.FileSystem,
  file: StagedFile,
  hash: string,
  contentType: string
) => {
  const prefix = `[{"key":${JSON.stringify(hash)},"value":"`
  const suffix = `","metadata":${JSON.stringify({ contentType })},"base64":true}]`
  const body = Stream.succeed(prefix).pipe(
    Stream.concat(encodeBase64(fs.stream(file.path, { chunkSize: 65536 }))),
    Stream.concat(Stream.succeed(suffix)),
    Stream.encodeText
  )
  return {
    byteLength: Buffer.byteLength(prefix + suffix) + 4 * Math.ceil(file.byteLength / 3),
    open: openStreamBody(body)
  }
}
