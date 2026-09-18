import { Effect, FileSystem } from "effect"
import { file } from "./entry.js"
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
        fs
          .stat(`${root}/${name}`)
          .pipe(Effect.map(info => ({ name, isFile: info.type === "File" }))),
      { concurrency: 8 }
    )

    // Recursive listings include directories, which are not deployable files.
    const files = stats.filter(entry => entry.isFile).map(entry => entry.name)

    const entries = yield* Effect.forEach(files, name => file(name, `${root}/${name}`), {
      concurrency: 8
    })

    return yield* make(entries)
  })
