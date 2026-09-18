import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { normalise } from "../../src/artifact/path.ts"

/**
 * `normalise` repairs what is cosmetic and rejects what is ambiguous.
 * Repairing a backslash cannot change which file was meant; stripping a
 * leading slash can, so that case fails instead.
 */

const accepts: ReadonlyArray<readonly [name: string, input: string, expected: string]> = [
  ["a simple relative path", "index.html", "index.html"],
  ["a nested path with an extension", "assets/img/logo.png", "assets/img/logo.png"],
  ["surrounding whitespace", "  index.html  ", "index.html"],
  ["a leading ./", "./a/b.js", "a/b.js"],
  ["repeated ./ prefixes", "././a.js", "a.js"],
  ["backslash separators", "dist\\x\\y.css", "dist/x/y.css"],
  ["duplicate slashes", "a//b/c.js", "a/b/c.js"],
  ["a . segment in the middle", "a/./b.js", "a/b.js"],
  ["mixed noise", "  ./a//b/./c.js  ", "a/b/c.js"],

  // Legal on every platform, so repaired or passed through rather than rejected.
  ["a leading space inside a segment", "dir/ a.txt", "dir/ a.txt"],
  ["a space in the middle", "my file.txt", "my file.txt"],
  ["a name that merely starts like a device", "console.js", "console.js"],
  ["a name containing a device name", "dir/recon.txt", "dir/recon.txt"],
  ["a segment of exactly 255 bytes", `${"a".repeat(255)}`, "a".repeat(255)],
  ["a dotfile", ".gitignore", ".gitignore"],
  ["a double extension", "app.min.js", "app.min.js"]
]

const rejects: ReadonlyArray<readonly [name: string, input: string, reason: string]> = [
  ["an empty path", "", "path is empty"],
  ["a whitespace-only path", "   ", "path is empty"],
  ["an absolute path", "/index.html", "path must be relative"],
  ["a backslash-absolute path", "\\index.html", "path must be relative"],
  ["a trailing slash", "assets/", "path must not end with a slash"],
  ["a bare ./", "./", "path must not end with a slash"],
  ["a leading ..", "../secret.env", "path must not contain '..'"],
  ["a .. in the middle", "a/../b.js", "path must not contain '..'"],
  ["a lone . segment", ".", "path has no segments"],

  // Windows absolutes. Neither has a leading slash, so the relative check alone
  // would let them through as relative paths named "C:/dist/app.js".
  [
    "a drive letter with forward slashes",
    "C:/dist/app.js",
    "path must not start with a drive letter"
  ],
  [
    "a drive letter with backslashes",
    "C:\\dist\\app.js",
    "path must not start with a drive letter"
  ],
  ["a lowercase drive letter", "d:/x.js", "path must not start with a drive letter"],
  ["a UNC path", "\\\\server\\share\\x.js", "path must be relative"],

  // Characters that are legal on Unix and illegal on Windows.
  // Not "a:b.txt": a single leading letter plus a colon is the drive-letter rule.
  ["a colon", "dir/a:b.txt", 'path must not contain any of < > : " | ? *'],
  ["a pipe", "a|b.txt", 'path must not contain any of < > : " | ? *'],
  ["a question mark", "a?.txt", 'path must not contain any of < > : " | ? *'],
  ["an asterisk", "a*.txt", 'path must not contain any of < > : " | ? *'],
  ["angle brackets", "<a>.txt", 'path must not contain any of < > : " | ? *'],
  ["a double quote", 'a".txt', 'path must not contain any of < > : " | ? *'],

  // Control characters. A newline in a path is a header-injection shape.
  ["a null byte", "a\u0000b.txt", "path must not contain control characters"],
  ["a newline", "a\nb.txt", "path must not contain control characters"],
  ["a tab", "a\tb.txt", "path must not contain control characters"],
  ["a DEL character", "a\u007fb.txt", "path must not contain control characters"],

  // Invisible characters: two different paths that render identically.
  ["a zero-width space", "a\u200bb.txt", "path must not contain invisible characters"],
  ["a byte order mark", "a\ufeffb.txt", "path must not contain invisible characters"],
  ["a bidi override", "a\u202eb.txt", "path must not contain invisible characters"],

  // Lone surrogates cannot be encoded as UTF-8 and become U+FFFD on the wire.
  ["a lone high surrogate", "a\ud800b.txt", "path must be valid UTF-8"],
  ["a lone low surrogate", "a\udc00b.txt", "path must be valid UTF-8"],

  // Windows silently strips these, so the deployed name would differ from the request.
  ["a segment ending in a dot", "dir./a.txt", "path segment must not end with a dot"],
  ["a file ending in a dot", "a.txt.", "path segment must not end with a dot"],
  ["a segment ending in a space", "dir /a.txt", "path segment must not end with a space"],

  // Reserved device names, with or without an extension, any case.
  ["CON", "CON", '"CON" is a reserved filename on Windows'],
  ["nul with an extension", "nul.txt", '"nul.txt" is a reserved filename on Windows'],
  ["COM1 in a subdirectory", "dir/COM1.js", '"COM1.js" is a reserved filename on Windows'],
  ["LPT9", "lpt9", '"lpt9" is a reserved filename on Windows'],

  // Length limits, counted in UTF-8 bytes rather than characters.
  ["a segment over 255 bytes", `${"a".repeat(256)}.txt`, "path segment must be at most 255 bytes"],
  [
    "a multibyte segment over 255 bytes",
    `${"é".repeat(128)}.txt`,
    "path segment must be at most 255 bytes"
  ],
  [
    "a path over 1024 bytes",
    Array.from({ length: 40 }, () => "a".repeat(30)).join("/"),
    "path must be at most 1024 bytes"
  ]
]

/**
 * macOS stores filenames decomposed (NFD) while Linux and Windows keep whatever
 * bytes they were given, so the same visible name can arrive in two encodings.
 * Without canonicalising, `café.txt` from a Mac and from Linux would be two
 * different keys and the artifact would deploy the file twice.
 */
describe("unicode canonicalisation", () => {
  const composed = "caf\u00e9.txt" // é as one code point
  const decomposed = "cafe\u0301.txt" // e + combining acute

  it.effect("maps NFD input to the NFC form", () =>
    Effect.gen(function* () {
      assert.notStrictEqual(composed, decomposed, "the inputs really are different strings")
      assert.strictEqual(yield* normalise(decomposed), composed)
    })
  )

  it.effect("makes both encodings produce the same path", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* normalise(composed), yield* normalise(decomposed))
    })
  )

  it.effect("leaves already-composed input alone", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* normalise(composed), composed)
    })
  )
})

describe("normalise", () => {
  describe("accepts", () => {
    for (const [name, input, expected] of accepts) {
      it.effect(name, () =>
        Effect.gen(function* () {
          const result = yield* normalise(input)
          assert.strictEqual(result, expected)
        })
      )
    }
  })

  describe("rejects", () => {
    for (const [name, input, reason] of rejects) {
      it.effect(name, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(normalise(input))
          assert.strictEqual(error._tag, "InvalidArtifactPathError")
          assert.strictEqual(error.reason, reason)
          assert.strictEqual(error.path, input, "the error echoes the original input")
        })
      )
    }
  })
})
