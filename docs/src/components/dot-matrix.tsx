"use client"

import { useEffect, useState } from "react"
import type { CSSProperties } from "react"
import { DotmSquare10 } from "./ui/dotm-square-10"
import { DotmSquare11 } from "./ui/dotm-square-11"
import { DotmSquare4 } from "./ui/dotm-square-4"
import { DotmSquare5 } from "./ui/dotm-square-5"
import { DotmSquare8 } from "./ui/dotm-square-8"

/**
 * One stage of the landing demo, drawn on a 5×5 dot grid.
 *
 * - `pending`: a dim, static grid.
 * - `active`: a Dot Matrix loader, the only state that loops.
 * - `done`: the loader fades out and a tick ripples in, then everything holds still.
 */
export type DotMatrixState = "pending" | "active" | "done"

const loaders = {
  scan: DotmSquare10, // CRT Glide
  diagonal: DotmSquare5, // Prism Sweep
  orbit: DotmSquare4, // Twin Orbit
  stack: DotmSquare8, // Strobe Stack
  ripple: DotmSquare11 // Echo Ring
}

export type DotMatrixPattern = keyof typeof loaders

/** Matches the loader's CSS fade-out, so it's removed only once it's invisible. */
const FADE_MS = 350

const SIZE = 24
const DOT = 4

/** The tick's dots in drawing order, as [row, col]: down the short stroke, up the long one. */
const tick: ReadonlyArray<readonly [number, number]> = [
  [2, 0],
  [3, 1],
  [2, 2],
  [1, 3],
  [0, 4]
]

const cells = Array.from({ length: 25 }, (_, index) => {
  const row = Math.floor(index / 5)
  const col = index % 5
  const stroke = tick.findIndex(([r, c]) => r === row && c === col)
  const distance = Math.hypot(row - 2, col - 2)
  return {
    index,
    lit: stroke !== -1,
    /** Background dots ripple out from the centre; the tick draws itself after them. */
    delay: stroke === -1 ? distance * 45 : 140 + stroke * 70
  }
})

export function DotMatrix({
  pattern,
  state,
  warn = false
}: {
  pattern: DotMatrixPattern
  state: DotMatrixState
  /** Amber while the stage is backing off, e.g. after a rate limit. */
  warn?: boolean
}) {
  const Loader = loaders[pattern]

  // Keep the loader animating while it fades out; stopping it early snaps it to a
  // bright static frame, which shows as a flicker. Unmount it once it's invisible.
  const [showLoader, setShowLoader] = useState(false)
  useEffect(() => {
    if (state === "active") {
      setShowLoader(true)
      return
    }
    const timer = setTimeout(() => setShowLoader(false), state === "done" ? FADE_MS : 0)
    return () => clearTimeout(timer)
  }, [state])
  return (
    <span className={`dot-matrix ${state}`}>
      <span className="dm-layer dm-idle">
        {cells.map(cell => (
          <i key={cell.index} />
        ))}
      </span>
      {showLoader && (
        <span className="dm-layer dm-loader">
          <Loader
            size={SIZE}
            dotSize={DOT}
            colorPreset={warn ? "grad-sunset" : "grad-neon"}
            bloom
            animated
          />
        </span>
      )}
      <span className="dm-layer dm-done">
        {cells.map(cell => (
          <i
            key={cell.index}
            className={cell.lit ? "lit" : undefined}
            style={{ "--delay": `${cell.delay}ms` } as CSSProperties}
          />
        ))}
      </span>
    </span>
  )
}
