/**
 * Composing an artifact from an ordered stack of layers.
 *
 * A deploy tree is usually not authored in one place. A prebuilt template
 * arrives from a CDN, generated config is written on top, collected assets on
 * top of that, and a user upload may deliberately shadow a file the template
 * shipped. Flattening all of that with a plain merge works, and throws away
 * the two things you want when a file turns out to be wrong: where it came
 * from, and what it replaced.
 *
 * So later layers still win, exactly as a merge would, but every override is
 * recorded in the result rather than logged and forgotten. Which overrides are
 * legitimate is the caller's policy, not a rule stated here: a user upload
 * shadowing a bundle file is intended, two producers inside one layer claiming
 * the same path usually is not, and only the caller knows which is which.
 */

import type { Entry } from "./entry.js"
import type { ArtifactPath } from "./path.js"
import type { Artifact } from "./artifact.js"

export interface ArtifactLayer {
  /** How this layer is named in overrides and summaries. */
  readonly name: string
  readonly entries: ReadonlyArray<Entry>
}

/** One file that displaced another at the same path. */
export interface Override {
  readonly path: ArtifactPath
  /** The layer whose entry survived. */
  readonly winner: string
  /**
   * The layer whose entry it replaced. Equal to `winner` when two producers
   * inside a single layer claimed the same path, which is the case worth
   * looking at hardest.
   */
  readonly replaced: string
}

export interface LayeredArtifact {
  readonly artifact: Artifact
  /** Every displacement, in the order it happened. */
  readonly overrides: ReadonlyArray<Override>
  /** Which layer supplied the surviving entry at a path. */
  readonly layerOf: (path: ArtifactPath) => string | undefined
}

/**
 * Stack layers into one artifact, later layers winning.
 *
 * Builds a single Map rather than folding immutable adds, so composing a
 * course-sized tree stays linear.
 */
export const layered = (layers: ReadonlyArray<ArtifactLayer>): LayeredArtifact => {
  const entries = new Map<ArtifactPath, Entry>()
  const origin = new Map<ArtifactPath, string>()
  const overrides: Array<Override> = []

  for (const layer of layers) {
    for (const entry of layer.entries) {
      const previous = origin.get(entry.path)
      if (previous !== undefined) {
        overrides.push({ path: entry.path, winner: layer.name, replaced: previous })
      }
      entries.set(entry.path, entry)
      origin.set(entry.path, layer.name)
    }
  }

  return {
    artifact: { entries },
    overrides,
    layerOf: path => origin.get(path)
  }
}

/**
 * Overrides where a layer displaced itself: two producers inside it claimed
 * the same path.
 *
 * Separated out because it is the one collision that is nearly always a
 * mistake, and because it is invisible in a flat merge.
 */
export const collisionsWithinLayers = (result: LayeredArtifact): ReadonlyArray<Override> =>
  result.overrides.filter(o => o.winner === o.replaced)

export interface LayerSummary {
  readonly name: string
  /** Entries this layer supplied, including ones later displaced. */
  readonly contributed: number
  /** Entries from this layer still present in the result. */
  readonly surviving: number
}

/**
 * Per-layer counts, for a deploy that can say what it is made of: how much came
 * from the template untouched, how much was generated, how much was overridden.
 */
export const summarise = (
  layers: ReadonlyArray<ArtifactLayer>,
  result: LayeredArtifact
): ReadonlyArray<LayerSummary> => {
  const surviving = new Map<string, number>()
  for (const path of result.artifact.entries.keys()) {
    const name = result.layerOf(path)
    if (name !== undefined) surviving.set(name, (surviving.get(name) ?? 0) + 1)
  }

  return layers.map(layer => ({
    name: layer.name,
    contributed: layer.entries.length,
    surviving: surviving.get(layer.name) ?? 0
  }))
}
