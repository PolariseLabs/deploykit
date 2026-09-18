/**
 * The digest Cloudflare Pages addresses assets by.
 *
 * Not sha1 of the bytes, which is Vercel's. Taken from wrangler's own
 * `hashFile`: blake3 over the base64 of the content concatenated with the
 * file extension, hex, truncated to 32 characters.
 *
 * The extension being part of the hash is the surprising bit, and the reason
 * a digest computed for one provider is worthless to another: the same bytes
 * at `a.txt` and `a.html` hash differently. That is why `DeferredEntry` keys
 * digests by algorithm rather than having a `sha1` field.
 */

import { blake3 } from "@noble/hashes/blake3.js"
import { bytesToHex } from "@noble/hashes/utils.js"

/** The key a caller uses to pre-supply this digest on a deferred entry. */
export const CLOUDFLARE_DIGEST = "blake3-b64ext"

const base64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** The extension without its dot, as wrangler takes it. */
export const extensionOf = (path: string): string => {
  const slash = path.lastIndexOf("/")
  const dot = path.lastIndexOf(".")
  return dot > slash + 1 ? path.slice(dot + 1) : ""
}

export const pagesDigest = (content: Uint8Array, path: string): string =>
  bytesToHex(blake3(new TextEncoder().encode(base64(content) + extensionOf(path)))).slice(0, 32)
