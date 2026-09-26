import { Buffer } from "node:buffer"

import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"

/** The key a caller uses to pre-supply this digest on a deferred entry. */
export const CLOUDFLARE_DIGEST = "blake3-b64ext"

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")

/** The extension without its dot, as wrangler takes it. */
export const extensionOf = (path: string): string => {
  const slash = path.lastIndexOf("/")
  const dot = path.lastIndexOf(".")
  return dot > slash + 1 ? path.slice(dot + 1) : ""
}

export const pagesDigest = (content: Uint8Array, path: string): string =>
  bytesToHex(blake3(new TextEncoder().encode(base64(content) + extensionOf(path)))).slice(0, 32)
