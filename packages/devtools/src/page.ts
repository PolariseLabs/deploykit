export const page = (nonce: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deploykit devtools</title>
<style nonce="${nonce}">
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: #000;
  color: #fff;
  font:
    14px system-ui,
    sans-serif;
}
main {
  max-width: 1400px;
  margin: auto;
  padding: 32px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #444;
  padding-bottom: 20px;
}
h1 {
  font-size: 22px;
  margin: 0;
}
h2 {
  font-size: 16px;
  margin: 28px 0 12px;
}
button,
a {
  color: #fff;
  background: #000;
  border: 1px solid #666;
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
}
button[aria-pressed="true"] {
  border-color: #fff;
  text-decoration: underline;
}
nav {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 24px 0;
}
p {
  line-height: 1.6;
}
table {
  border-collapse: collapse;
  width: 100%;
  text-align: left;
}
td,
th {
  border-bottom: 1px solid #333;
  padding: 12px 8px;
  vertical-align: top;
}
th {
  font-weight: 500;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}
#metrics {
  display: flex;
  gap: 40px;
  flex-wrap: wrap;
}
#metrics strong {
  font-size: 24px;
  display: block;
}
progress {
  width: 100%;
  height: 8px;
  accent-color: #fff;
}
#connection {
  font-size: 12px;
}
details {
  margin: 12px 0;
  border-bottom: 1px solid #333;
  padding-bottom: 10px;
}
summary {
  cursor: pointer;
}
small {
  font-size: 12px;
}
.scroll {
  overflow: auto;
}
a {
  display: inline-block;
}
#notice {
  color: #ffc66b;
}
@media (max-width: 600px) {
  main {
    padding: 16px;
  }
  #metrics {
    gap: 20px;
  }
  td,
  th {
    padding: 8px 4px;
  }
}
</style></head><body><main><header><h1>Deploykit / local</h1><div><button id="pause">Pause updates</button> <span id="connection">Connecting</span></div></header><p id="notice"></p><nav id="runs"></nav><div id="content"><p>Waiting for a tracked deployment.</p></div></main>
<script nonce="${nonce}">
let selected,
  latest,
  paused = false
const el = (tag, text) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = String(text)
  return node
}
document.querySelector("#pause").onclick = () => {
  paused = !paused
  document.querySelector("#pause").textContent = paused ? "Resume updates" : "Pause updates"
  if (!paused && latest) render(latest)
}
const seconds = (ms) => (ms / 1000).toFixed(2) + " s",
  mb = (n) => (n / 1048576).toFixed(2) + " MiB"
function render(data) {
  latest = data
  if (paused) return
  const expanded = new Set(
    [...document.querySelectorAll("details[open]")].map((node) => node.dataset.sequence),
  )
  document.querySelector("#connection").textContent =
    "Connected · " + new Date(data.timestamp).toLocaleTimeString()
  document.querySelector("#notice").textContent =
    data.dropped || data.exportFailures || data.omittedRuns
      ? "Telemetry: " +
        data.dropped +
        " exports dropped, " +
        data.exportFailures +
        " export failures, " +
        data.omittedRuns +
        " older runs omitted."
      : ""
  const nav = document.querySelector("#runs")
  nav.replaceChildren()
  if (!data.runs.length) return
  if (!data.runs.some((r) => r.id === selected)) selected = data.runs[data.runs.length - 1].id
  for (const run of data.runs) {
    const b = el("button", run.label + " · " + run.status)
    b.setAttribute("aria-pressed", String(run.id === selected))
    b.onclick = () => {
      selected = run.id
      render(latest)
    }
    nav.append(b)
  }
  const run = data.runs.find((r) => r.id === selected),
    events = run.events
  const content = document.querySelector("#content")
  content.replaceChildren()
  const progress = run.stats.uploadTotal
    ? {
        done: run.stats.uploadedFiles,
        total: run.stats.uploadTotal,
        bytes: run.stats.uploadedBytes,
      }
    : null
  const input = { files: run.stats.inputFiles }
  const metrics = el("div")
  metrics.id = "metrics"
  for (const [label, value] of [
    ["Elapsed", seconds(run.durationMs)],
    ["Batch acknowledged", progress ? mb(progress.bytes || 0) : "No uploads reported"],
    [
      "Files",
      progress
        ? (progress.done || 0) + " / " + progress.total
        : input
          ? input.files + " in artifact"
          : "—",
    ],
    ["Process RSS", mb(data.processRssBytes)],
    ["Cached contents", run.stats.cachedContents],
    ["Retries observed", run.stats.retries],
  ]) {
    const item = el("div")
    item.append(el("strong", value), el("span", label))
    metrics.append(item)
  }
  content.append(metrics)
  const deployment = events.filter((item) => item.event.kind === "deployment").at(-1)?.event
  if (deployment?.url) {
    try {
      const url = new URL(deployment.url)
      if (url.protocol === "https:") {
        const link = el("a", "Open deployment")
        link.href = url.href
        link.target = "_blank"
        link.rel = "noopener noreferrer"
        content.append(el("p", deployment.status), link)
      }
    } catch {}
  }
  if (progress) {
    const bar = el("progress")
    bar.max = progress.total || 1
    bar.value = progress.done || 0
    content.append(
      el(
        "p",
        "Upload progress counts provider acknowledgements, not bytes currently on the wire.",
      ),
      bar,
    )
  }
  content.append(el("p", "Run " + run.id + " · Correlation " + run.correlationId))
  const operations = new Map()
  for (const item of events) {
    const e = item.event
    if (e.kind === "operation.started") operations.set(e.id, { ...e, start: item.elapsedMs })
    if (e.kind === "operation.finished") operations.set(e.id, { ...operations.get(e.id), ...e })
  }
  const rows = [...operations.values()]
  content.append(el("h2", "Timing breakdown"))
  const timing = el("table"),
    timingHead = el("tr")
  for (const title of [
    "Operation",
    "Count",
    "Cumulative",
    "Mean",
    "Slowest",
    "Failed attempts",
  ])
    timingHead.append(el("th", title))
  timing.append(timingHead)
  for (const [name, stats] of Object.entries(run.stats.operations)) {
    const row = el("tr")
    for (const value of [
      name,
      stats.count,
      seconds(stats.totalMs),
      seconds(stats.totalMs / stats.count),
      seconds(stats.maxMs),
      stats.failures,
    ])
      row.append(el("td", value))
    timing.append(row)
  }
  const timingScroll = el("div")
  timingScroll.className = "scroll"
  timingScroll.append(timing)
  content.append(
    timingScroll,
    el(
      "p",
      "Cumulative timings overlap for concurrent and nested operations; they do not add up to elapsed time.",
    ),
    el("h2", "Recent operations"),
  )
  const table = el("table"),
    head = el("tr")
  for (const text of ["Operation", "Outcome", "Duration", "Details"])
    head.append(el("th", text))
  table.append(head)
  for (const op of rows.slice(-100).reverse()) {
    const row = el("tr")
    row.append(
      el("td", op.provider + " / " + op.operation),
      el("td", op.outcome || "running"),
      el("td", seconds(op.durationMs ?? Math.max(0, run.durationMs - op.start))),
      el("td", op.failure ? JSON.stringify(op.failure) : ""),
    )
    table.append(row)
  }
  const scroll = el("div")
  scroll.className = "scroll"
  scroll.append(table)
  content.append(scroll)
  content.append(el("h2", "Event timeline"))
  const controls = el("button", "Download retained events")
  controls.onclick = () => {
    const blob = new Blob([JSON.stringify(run, null, 2)], { type: "application/json" })
    const a = el("a")
    a.href = URL.createObjectURL(blob)
    a.download = "deploykit-" + run.id + ".json"
    a.click()
    URL.revokeObjectURL(a.href)
  }
  content.append(controls)
  content.append(
    el(
      "p",
      run.omittedEvents +
        " older events omitted. RSS is for the whole process. Export delivery is best effort; " +
        data.pending +
        " events pending.",
    ),
  )
  for (const item of events.slice(-80).reverse()) {
    const d = el("details")
    d.dataset.sequence = String(item.sequence)
    d.open = expanded.has(String(item.sequence))
    d.append(
      el("summary", seconds(item.elapsedMs) + " · " + item.event.kind),
      el("pre", JSON.stringify(item, null, 2)),
    )
    content.append(d)
  }
}
async function refresh() {
  try {
    const response = await fetch("/events")
    if (!response.ok) throw Error()
    render(await response.json())
  } catch {
    document.querySelector("#connection").textContent =
      "Disconnected · showing last observation"
  }
  setTimeout(refresh, 750)
}
refresh()
</script></body></html>`
