import { Effect, FileSystem } from "effect"
import { fileWithSize } from "./entry.js"
import { make } from "./artifact.js"

/**
 * Builds an Artifact from every file under `root`, recursively.
 *
 * Destination paths are relative to `root`; sources stay as given so bytes are
 * read at upload time. Nothing is filtered, including dotfiles: deciding what
 * belongs in a deployment is the caller's policy. `stat` follows symlinks, so a
 * link out of `root` resolves to its target.
 */
export const fromDirectory = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const names = yield* fs.readDirectory(root, { recursive: true })

    // forEach, not filter: filter does not preserve input order under
    // concurrency, and an Artifact promises deterministic iteration.
    const stats = yield* Effect.forEach(
      // Sorted because directory listing order is not stable across filesystems.
      [...names].sort(),
      name =>
        fs.stat(`${root}/${name}`).pipe(
          Effect.map(info => ({
            name,
            isFile: info.type === "File",
            byteLength: Number(info.size)
          }))
        ),
      { concurrency: 8 }
    )

    // Recursive listings include directories, which are not deployable files.
    const files = stats.filter(entry => entry.isFile)

    // The stat above already told us the size, so the entries are built
    // without a second syscall each.
    const entries = yield* Effect.forEach(
      files,
      entry => fileWithSize(entry.name, `${root}/${entry.name}`, entry.byteLength),
      { concurrency: 8 }
    )

    return yield* make(entries)
  })
