/** Portability rules for a single path segment: the intersection of what Windows, macOS and Linux allow. */

/** Longest filename on ext4, APFS and NTFS, in UTF-8 bytes rather than characters. */
const MAX_SEGMENT_BYTES = 255

/** Conservative whole-path cap; Windows without long-path support stops around 260. */
export const MAX_PATH_BYTES = 1024

/** Illegal in Windows filenames, legal on Unix. */
const WINDOWS_FORBIDDEN = /[<>:"|?*]/

/** C0 controls, DEL and C1. A newline in a path is a header-injection shape. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

/** Half a surrogate pair with no partner: cannot be encoded as UTF-8. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Reserved on Windows whatever the extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Zero-width and bidirectional marks: two paths that render identically. */
const INVISIBLE = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/

/** A leading drive letter, so "C:/dist" is not mistaken for a relative path. */
export const DRIVE_LETTER = /^[a-z]:/i

export const utf8Length = (value: string) => new TextEncoder().encode(value).length

/** Why this segment is unacceptable, or undefined if it is fine. */
export const segmentProblem = (segment: string): string | undefined => {
  if (CONTROL_CHARACTERS.test(segment)) return "path must not contain control characters"
  if (LONE_SURROGATE.test(segment)) return "path must be valid UTF-8"
  if (INVISIBLE.test(segment)) return "path must not contain invisible characters"
  if (WINDOWS_FORBIDDEN.test(segment)) return `path must not contain any of < > : " | ? *`
  // Windows silently strips these, so the deployed name would differ from the request.
  if (segment.endsWith(".")) return "path segment must not end with a dot"
  if (segment.endsWith(" ")) return "path segment must not end with a space"
  if (WINDOWS_RESERVED.test(segment)) return `"${segment}" is a reserved filename on Windows`
  if (utf8Length(segment) > MAX_SEGMENT_BYTES) {
    return `path segment must be at most ${MAX_SEGMENT_BYTES} bytes`
  }
  return undefined
}
