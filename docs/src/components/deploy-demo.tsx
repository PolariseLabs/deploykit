"use client"

import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { DotMatrix } from "./dot-matrix"
import type { DotMatrixPattern } from "./dot-matrix"
import { highlight } from "./highlight"

/**
 * The demo's steps, in order. It plays once, then waits for Replay.
 *
 * `throttled` and `retry` show a real SDK behaviour: an upload rate-limited with a
 * short Retry-After is waited out and retried. Creating the deployment never is,
 * so the retry stays inside the upload stage.
 */
type Phase =
  "idle" | "read" | "hash" | "negotiate" | "upload" | "throttled" | "retry" | "build" | "live"

const BACKOFF_MS = 2400

const timeline: ReadonlyArray<readonly [Phase, number]> = [
  ["read", 500],
  ["hash", 1000],
  ["negotiate", 1500],
  ["upload", 1400],
  ["throttled", BACKOFF_MS],
  ["retry", 1200],
  ["build", 1200],
  ["live", 0]
]

const lines = [
  "const deploykit = yield* Deploykit.Deploykit",
  'const artifact = yield* Artifact.fromDirectory("./dist")',
  "const live = yield* deploykit.deployAndWait(appId, artifact)",
  "return live.url"
]

/** Which code line is running during each phase. */
const lineFor: Record<Phase, number> = {
  idle: 0,
  read: 1,
  hash: 2,
  negotiate: 2,
  upload: 2,
  throttled: 2,
  retry: 2,
  build: 2,
  live: 3
}

const COLUMNS = 24
const FILES = COLUMNS * 10
/** Files that changed since the last deploy. The last one gets rate-limited once. */
const CHANGED = [31, 58, 97, 142, 176, 213]
const RETRIED = CHANGED[CHANGED.length - 1]!
const changed = new Set(CHANGED)

/** Counts up to `to` once, easing out, then stops. */
function CountUp({ to, ms = 600 }: { to: number; ms?: number }) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      setValue(Math.round(to * (1 - (1 - t) ** 3)))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [to, ms])
  return <>{value}</>
}

/** Counts down from `ms` to zero once, in tenths of a second. */
function CountDown({ ms }: { ms: number }) {
  const [left, setLeft] = useState(ms)
  useEffect(() => {
    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const remaining = Math.max(0, ms - (now - start))
      setLeft(remaining)
      if (remaining > 0) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [ms])
  return <>{(left / 1000).toFixed(1)}s</>
}

const status = (phase: Phase): ReactNode => {
  switch (phase) {
    case "idle":
      return ""
    case "read":
      return (
        <>
          <CountUp to={FILES} /> files
        </>
      )
    case "hash":
      return "hashing"
    case "negotiate":
      return (
        <>
          <CountUp to={FILES - CHANGED.length} /> already on the host
        </>
      )
    case "upload":
      return `uploading ${CHANGED.length} changed files`
    case "throttled":
      return (
        <>
          429 rate limited, retrying in <CountDown ms={BACKOFF_MS} />
        </>
      )
    case "retry":
      return `retried, ${CHANGED.length} sent`
    case "build":
      return "building"
    case "live":
      return "https://acme.example.app"
    default: {
      const exhaustive: never = phase
      return exhaustive
    }
  }
}

const order: ReadonlyArray<Phase> = ["idle", ...timeline.map(([phase]) => phase)]
const reached = (phase: Phase, step: Phase) => order.indexOf(phase) >= order.indexOf(step)

/** The pipeline strip under the demo: each stage lights up when its phase is reached. */
const stages: ReadonlyArray<{
  phase: Phase
  /** The stage stays active until this phase starts. */
  until: Phase
  pattern: DotMatrixPattern
  label: string
  detail: (phase: Phase) => string
}> = [
  {
    phase: "read",
    until: "hash",
    pattern: "scan",
    label: "Files",
    detail: () => `${FILES} files`
  },
  {
    phase: "hash",
    until: "negotiate",
    pattern: "diagonal",
    label: "Hash",
    detail: () => `${FILES} / ${FILES}`
  },
  {
    phase: "negotiate",
    until: "upload",
    pattern: "orbit",
    label: "Negotiate",
    detail: () => `${FILES - CHANGED.length} skipped`
  },
  {
    phase: "upload",
    until: "build",
    pattern: "stack",
    label: "Upload",
    detail: phase =>
      reached(phase, "retry") ? `${CHANGED.length} sent · 1 retry` : `${CHANGED.length} sent`
  },
  { phase: "build", until: "live", pattern: "ripple", label: "Live", detail: () => "ready" }
]

export function DeployDemo() {
  const [phase, setPhase] = useState<Phase>("idle")
  const [run, setRun] = useState(0)

  useEffect(() => {
    setPhase("idle")
    const timers: Array<ReturnType<typeof setTimeout>> = []
    let at = 300
    for (const [next, duration] of timeline) {
      timers.push(setTimeout(() => setPhase(next), at))
      at += duration
    }
    return () => timers.forEach(clearTimeout)
  }, [run])

  const cellClass = (index: number) => {
    if (!reached(phase, "read")) return "cell"
    if (index === RETRIED && phase === "throttled") return "cell failed"
    if (index === RETRIED && reached(phase, "retry")) return "cell sent"
    if (changed.has(index) && index !== RETRIED && reached(phase, "upload")) return "cell sent"
    if (!changed.has(index) && reached(phase, "negotiate")) return "cell stored"
    if (reached(phase, "hash")) return "cell hashed"
    return "cell read"
  }

  /** Sweeps run left to right and top to bottom; uploads go one after another. */
  const cellDelay = (index: number) => {
    const upload = CHANGED.indexOf(index)
    if (upload !== -1 && phase === "upload") return upload * 140
    return (index % COLUMNS) * 10 + Math.floor(index / COLUMNS) * 30
  }

  const throttled = phase === "throttled"

  /**
   * How far along the pipeline line is, in stages. While rate-limited it slips back
   * towards Negotiate, then moves forward again when the retry goes through.
   */
  const reachedStage = Math.max(
    0,
    stages.findLastIndex(stage => reached(phase, stage.phase))
  )
  const progress = throttled ? reachedStage - 0.45 : reachedStage

  return (
    <div className="demo">
      <div className="demo-bar">
        <span>publish.ts</span>
        <button type="button" onClick={() => setRun(run + 1)}>
          Replay
        </button>
      </div>
      <div className="demo-body">
        <pre className="demo-code">
          {lines.map((line, index) => (
            <div key={line} className={index === lineFor[phase] ? "line active" : "line"}>
              {highlight(line)}
            </div>
          ))}
        </pre>
        <div className="demo-visual">
          <div className="cells" style={{ gridTemplateColumns: `repeat(${COLUMNS}, 1fr)` }}>
            {Array.from({ length: FILES }, (_, index) => (
              <i
                key={index}
                className={cellClass(index)}
                style={{ transitionDelay: `${cellDelay(index)}ms` }}
              />
            ))}
          </div>
          <div
            className={
              phase === "live" ? "demo-status live" : throttled ? "demo-status warn" : "demo-status"
            }
          >
            {/* A new key per phase remounts the text, replaying its entrance. */}
            <span key={phase}>{status(phase)}</span>
          </div>
        </div>
      </div>
      <ol className="stages">
        <li
          className={throttled ? "stages-fill warn" : "stages-fill"}
          aria-hidden
          style={{ width: `${(progress / (stages.length - 1)) * 80}%` }}
        />
        {stages.map(stage => (
          <li
            key={stage.phase}
            className={[
              "stage",
              reached(phase, stage.phase) ? "on" : "",
              throttled && stage.phase === "upload" ? "warn" : ""
            ].join(" ")}
          >
            <DotMatrix
              pattern={stage.pattern}
              warn={throttled && stage.phase === "upload"}
              state={
                reached(phase, stage.until)
                  ? "done"
                  : reached(phase, stage.phase)
                    ? "active"
                    : "pending"
              }
            />
            <b>{stage.label}</b>
            <span className="stage-detail">{stage.detail(phase)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
