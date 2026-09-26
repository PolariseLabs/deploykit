# Local transfer benchmark

Recorded 2026-09-25 on macOS arm64, Bun 1.3.5, Effect 4.0.0-rc.112.
Run `bun run benchmark` to reproduce. Values below are one run, not statistical estimates.

The script generates unique files lazily, supplies fingerprints, and runs the actual
adapter transfer paths against in-memory clients. Each upload acknowledges after a
1 ms delay. There is no DNS, TLS, provider latency, HTTP serialization or real account.
Pages base64 conversion and hashing are included. Fixture metadata construction is
excluded from elapsed time but may remain resident in RSS.

All jobs in a scenario share a 160 MiB reservation budget. Reservations use 16 times
raw file size plus 8 MiB of overhead. Per-job upload concurrency is eight for Vercel,
four for Pages. Sources return a fresh full-file chunk; production sources can instead
return small scoped chunks. Warm runs start with every fingerprint cached.

RSS is sampled every 5 ms and at completion. Synchronous work can hide shorter peaks;
runtime, allocator and prior-run garbage are included. The cap is on reserved transfer
work, not RSS. Concurrent cold jobs can independently upload the same cache miss;
there is no cross-job upload deduplication promise.

| Provider   | Cache | Files/job | MiB/job | Jobs | Elapsed ms | Reads | Uploaded MiB | Start RSS MiB | Peak RSS MiB |
| ---------- | ----- | --------- | ------- | ---- | ---------- | ----- | ------------ | ------------- | ------------ |
| vercel     | cold  | 100       | 6.25    | 1    | 23         | 100   | 6.25         | 146.75        | 159.91       |
| vercel     | warm  | 100       | 6.25    | 1    | 1          | 0     | 0.00         | 161.03        | 161.97       |
| vercel     | cold  | 16        | 64.00   | 4    | 201        | 64    | 256.00       | 194.41        | 224.41       |
| vercel     | warm  | 16        | 64.00   | 4    | 0          | 0     | 0.00         | 224.42        | 224.42       |
| cloudflare | cold  | 100       | 6.25    | 1    | 43         | 100   | 6.25         | 282.73        | 295.34       |
| cloudflare | warm  | 100       | 6.25    | 1    | 1          | 0     | 0.00         | 295.42        | 295.55       |
| cloudflare | cold  | 16        | 64.00   | 4    | 1307       | 64    | 256.00       | 350.05        | 409.30       |
| cloudflare | warm  | 16        | 64.00   | 4    | 0          | 0     | 0.00         | 409.30        | 409.31       |

Warm scenarios performed zero reads and uploads. The large scenario moved 256 MiB
across four jobs with a shared reservation budget. Focused tests separately verify
permit release, serialization when two jobs cannot fit, oversized-file rejection,
source finalization, reader abort signals and HTTP response cancellation.

This establishes local behaviour for the supported buffered path. It does not qualify
hosting limits, network throughput, process-wide memory safety or larger files. Vercel and Cloudflare staging and streaming uploads were added after these measurements; the numbers
above describe only the buffered path. Local tests now exercise 9 MiB staged files and the 25 MiB Cloudflare boundary,
including retries and cancellation. They are correctness tests, not memory benchmarks.
Archive optimization remains outside this implementation.

## large-artifact offline fixture (2026-09-25)

An external synthetic fixture
preserves 2,191 anonymized paths and 884,799,521 synthetic bytes, including a
69,531,590-byte largest file. Its original verification passed unchanged. The extended
verifier runs 14 independently asserted cases, each in a fresh Node v25.2.1 process.
Two-publish cases run both instances in the same process. All provider HTTP is injected
and offline; no application correctness or live-provider performance is implied.

| Scenario               | Publishes in process | Source / upload bytes         | Elapsed ms | Process peak RSS MiB | Sampled staging MiB | Peak reserved disk MiB |
| ---------------------- | -------------------- | ----------------------------- | ---------- | -------------------- | ------------------- | ---------------------- |
| cold                   | 1                    | 884,799,521 / 884,799,521     | 1594       | 397.94               | 104.84              | 121.59                 |
| warm                   | 1                    | 0 / 0                         | 54         | 175.88               | 0.00                | 0.00                   |
| config                 | 1                    | 112,908 / 112,908             | 56         | 177.17               | 0.00                | 0.00                   |
| image                  | 1                    | 1,210,813 / 1,210,813         | 58         | 178.38               | 0.00                | 0.00                   |
| eviction               | 1                    | 70,742,403 / 70,742,403       | 264        | 264.59               | 66.31               | 66.31                  |
| concurrent-shared      | 2                    | 1,769,599,042 / 1,769,599,042 | 3125       | 452.20               | 126.36              | 126.36                 |
| concurrent-independent | 2                    | 1,769,599,042 / 1,769,599,042 | 2966       | 381.44               | 211.87              | 243.18                 |
| backpressure           | 1                    | 69,531,590 / 69,531,590       | 1508       | 210.45               | 66.31               | 66.31                  |

These are single observations, not distributions. Process RSS is the OS lifetime
high-water mark and includes fixture setup, runtime and GC. Disk payload sizes are
sampled recursively every 5 ms; reservation peaks are exact. Shared budgets were
256 MiB memory and 128 MiB disk; independent mode allocated those budgets per publish.
The lower independent-mode RSS in this run is not a demonstrated memory benefit.
All reservations and staged files were released. The full fixture cannot deploy to
Pages unchanged because two assets exceed 25 MiB; actual-adapter preflight rejects
it without reads or HTTP. Full results, commands and limitations are in the fixture.

## Vercel scheduling and readiness investigation (2026-09-25)

The real external fixture was exercised through the actual adapter with injected
offline HTTP. Each of 12 settings ran twice in fresh Bun processes: 24 runs total.
Every run independently verified 326 unique uploads, 344,486,159 source/upload
bytes, SHA-1 and length integrity, original paths, deferred activation and released
256 MiB memory/disk budgets. These are single-publish processes, not concurrent
publish measurements. Timing excludes input loading.

Both models impose 100 ms per request. One permits 32 MiB/s per request; the other
shares a 64 MiB/s link. Times below are two-run means; resource figures are the
larger observed peaks. RSS includes runtime and GC; disk figures are reservations.

| Model       | Order         | Concurrency | Seconds | Peak RSS MiB | Reserved disk MiB |
| ----------- | ------------- | ----------- | ------- | ------------ | ----------------- |
| Per request | Manifest      | 8           | 8.300   | 276.81       | 80.07             |
| Per request | Manifest      | 16          | 5.759   | 304.52       | 80.07             |
| Per request | Largest first | 16          | 5.353   | 357.30       | 157.02            |
| Shared link | Manifest      | 8           | 7.785   | 326.80       | 93.98             |
| Shared link | Manifest      | 16          | 6.265   | 298.59       | 129.58            |
| Shared link | Largest first | 16          | 5.794   | 338.14       | 157.02            |

Manifest-order concurrency 16 improved these modeled times by 19.5–30.6%. Largest
first was mixed: at concurrency 8 it slowed the shared-link model from 7.785 to
8.369 seconds. Neither setting is qualified against live provider throttling.
Defaults remain eight uploads in manifest order; tuning is opt-in. These results
are not predictions of Vercel or Fluid performance. Private raw results and the
harness remain outside the repository beside the real fixture.

Provider timestamps and build logs explain the original readiness wait: 18.275
seconds from provider creation to READY, including 2.583 seconds before its file
download, 10.123 seconds downloading the tree and 5.565 seconds deploying outputs.
It used prebuilt artifacts without application compilation. The observed client
wait was 20.582 seconds; polling and request latency delay detection.

An unchanged live repeat in the same isolated project opened zero sources and
uploaded zero bytes. Provider creation-to-READY was 11.533 seconds: 1.234 seconds
before download, 5.736 downloading and 4.558 deploying outputs. With caller-owned
one-second polling, READY was observed 823 ms after its provider timestamp.
Two samples do not establish the cause of provider variation. Both deployments
remain staged with no production target; no production project was touched.

## Live Vercel concurrency trials (2026-09-25)

Four real uploads/deployments ran in the retained isolated test project, in order
8, 16, 16, 8. Fresh synthetic bytes matched the real fixture's unique-content size
distribution and duplicate placements; the customer artifact was not modified.
The test tree contained 2,187 binary paths plus a config and index page. This tests
transport shape, not application rendering. Each run uploaded 326 contents and
approximately 344.49 MB; total transferred payload was 1,377,945,142 bytes.

| Concurrency | Upload seconds | Creation seconds | READY wait seconds | Peak RSS MiB | Sampled staging MiB | Peak active requests |
| ----------- | -------------- | ---------------- | ------------------ | ------------ | ------------------- | -------------------- |
| 8           | 59.931         | 62.492           | 19.877             | 286.30       | 93.92               | 8                    |
| 16          | 53.101         | 55.463           | 20.076             | 313.95       | 101.94              | 15                   |
| 16          | 53.476         | 55.589           | 28.176             | 296.62       | 121.33              | 13                   |
| 8           | 55.279         | 57.718           | 25.098             | 298.06       | 93.94               | 8                    |

Upload time spans the first request start through the last acknowledgement.
Creation includes upload time; READY wait starts after the creation response.
Each publish ran in a fresh Bun process. RSS was sampled every 20 ms and includes
runtime/source generation; temporary disk payload was sampled at the same cadence.
Shared memory and disk reservations were each capped at 256 MiB and released.
The dashboard process was separate and its displayed RSS is not worker RSS.

The mean upload improvement was 7.5% (57.605 to 53.289 seconds), based on only two
observations per setting on this workstation/network. No HTTP 429, transport retry
or ambiguous creation occurred. Retries were disabled so throttling would stop the
comparison; the HTTP deadline was 120 seconds. The largest file's upload took
37.736 and 41.706 seconds at concurrency 16, beyond the default 30-second deadline.
At concurrency 8 it took 27.963 and 25.957 seconds. This is a reason to retain
conservative defaults, not evidence of a fixed provider concurrency limit.

Every deployment reached READY without setting a production target. Its index and
the full 69,531,590-byte largest file were verified. The first verifier incorrectly
expected a fresh upload for empty content, whose hash is universal; its assertion
was corrected after independently checking payload totals and the deployed file.
The existing deployment was verified without creating a duplicate. Raw receipts
retain that harness correction outside the repository.

An additional 1 MiB live smoke test exercised `uploadThrottle: "balanced"`: 17
successful uploads, maximum eight in flight, start intervals 100–104 ms except one
209 ms interval, and 15 recorded throttle-wait spans. Its deployed binary matched
the source. Shared 429 cooldown/reset handling is covered locally with a test
clock; no live throttle was intentionally provoked. API quota headers advertised
a 5,000-upload limit in these responses; this is not a concurrency allowance.

These tests qualify neither Fluid performance nor multiple-process coordination,
provider throttling/recovery, production readiness or adaptive concurrency.

## Real Convex to Fluid handoff (2026-09-25)

Synthetic immutable Pages assets supplied a 25 MiB binary and 28-byte HTML file.
The Fluid consumer added a 22-byte config and Vercel output metadata, using packed
SDKs, aligned Effect rc.112, Node 22.23.2 and the `iad1` region. Budgets were 64 MiB
for transfer reservations and 32 MiB for staging. These requests ran sequentially.

| Invocation      | Worker through create | Source bytes | Acknowledged upload bytes | Peak sampled process RSS | Peak staging reservation |
| --------------- | --------------------: | -----------: | ------------------------: | -----------------------: | -----------------------: |
| Convex cold     |               4.144 s |   26,214,428 |                26,214,450 |               118.89 MiB |                   25 MiB |
| Convex warm     |               0.937 s |            0 |                         0 |                84.73 MiB |                        0 |
| Standalone warm |               0.626 s |            0 |                         0 |                92.31 MiB |                        0 |

The cold staged-file read/hash took 0.813 s and its 25 MiB upload took 2.514 s.
Initial missing-file negotiation took 0.323 s; final creation took 0.453 s. Nested
or overlapping stage durations must not be added as wall time. CLI-inclusive caller
elapsed times were 5.313 s cold and 1.803 s warm; standalone HTTP took 0.987 s.

Worker timing ends at deployment creation, before readiness and application checks.
Warm readiness observations took another approximately 6.4 / 6.2 seconds including
Convex CLI calls and polling. Cold readiness was checked later, so its true latency
was not measured. Full asset hashes, generated config and unchanged production
routing were independently verified.

RSS was sampled every 20 ms inside the worker process. Instance reuse/isolation was
not controlled, so these rows are not fresh-process memory comparisons. Staging
numbers measure SDK reservations, not a filesystem sampler. Reservations returned
to zero; runtime buffers, other work in a Fluid instance and GC are outside them.
There was one successful observation per row. Failed diagnostic runs are retained
separately and excluded from this table. This is neither a large-artifact Fluid
benchmark nor a prediction of customer publish latency or account capacity.

## Full-sized Fluid qualification (2026-09-25)

The real 2,187-file artifact declares 884,749,386 bytes across all destinations.
Its 326 unique contents total 344,486,159 bytes; deploykit deduplicates uploads.
The real audit read each unique source through HTTP and checked it against the
original manifest. Vercel already cached those bytes, so cold upload trials used
fresh AES-generated content preserving sizes and duplicate structure. Those trials
add a small test index and output config; they are not copies of the original application.

| Trial                              | Source bytes | Upload bytes |    Audit | Through creation | Additional readiness | Sampled process RSS |
| ---------------------------------- | -----------: | -----------: | -------: | ---------------: | -------------------: | ------------------: |
| Real source audit + cached publish |  344,486,159 |            0 | 12.562 s |          1.361 s |             22.755 s |          190.18 MiB |
| Real unchanged repeat              |            0 |            0 |     none |          0.971 s |             14.242 s |          197.07 MiB |
| Synthetic cold                     |  344,486,239 |  344,486,239 |     none |         38.566 s |             27.111 s |          275.00 MiB |
| Synthetic pair, job 1              |  344,486,245 |  344,486,245 |     none |         75.994 s |             53.797 s |   372.14 MiB shared |
| Synthetic pair, job 2              |  344,486,245 |  344,486,245 |     none |         75.593 s |             32.524 s |        same process |

All jobs ran Node 22.23.2 in iad1 through actual Vercel APIs and a 300-second
function. A caller deadline was 270 seconds, HTTP operations 120 seconds, and the
balanced throttle bounded eight upload requests with 100 ms start spacing. The
synthetic pair shared a client and budgets in one invocation; this was not an
assumption about Vercel colocating separate requests. Total pair wall time was
130.184 seconds. No 429s, upload retries or telemetry drops occurred.

The cold upload peaked at 255.59 MiB of memory reservations and 94.07 MiB of disk
reservations. The pair peaked at 255.99 / 107.48 MiB against configured 256 / 128 MiB
limits. Reservations and scoped staging directories were released. RSS includes
runtime, manifests, GC and consumer buffers beyond SDK reservations.

Two additional real audits overlapped in one invocation, reading 688,972,318 bytes
and deploying cached trees. Their audit times were 11.425 / 12.656 seconds. Peak
sampled RSS was 248.78 MiB; disk reservations peaked at 85.86 MiB, while recursively
sampled staged file bytes peaked at 66.31 MiB. The initial sampler only counted
nested directory entries, so its physical disk readings are invalid and omitted.
The corrected measurement is a separate audit workload, not a cold-upload disk
measurement. Filesystem metadata/block allocation is not included.

Samples ran every 25 ms. One observation per scenario is not a distribution or
capacity guarantee. The cold and concurrent synthetic requests reused the same
instance; RSS rows are observations, not controlled fresh-process memory comparisons.
The additional real audit ran on another worker deployment and overlapped the late
part of the synthetic pair. Do not infer speedup, scaling efficiency or a provider
concurrency limit from these timings.

Provider timestamps clarify the readiness delay. The unchanged real deployment
spent 0.990 s from creation to BUILDING and 12.680 s from BUILDING to READY. The
synthetic pair spent 34.537 / 14.151 s before BUILDING, then 19.476 / 18.229 s to
READY. These are provider-observed phases, not SDK upload time or proof of the
internal scheduling cause. The polling observations above include polling latency.

Five real browser routes and seven selected real file downloads passed. Nine
synthetic downloads totaling 211,439,697 bytes passed size, SHA-256 and SHA-1 checks.
Private fixture paths returned 404. The active test deployment target was unchanged.
Raw manifests, receipts, worker samples and JSONL events remain in the external
qualification directory; they are not published with the SDK.

## Bounded multi-instance Fluid trial (2026-09-25)

Two waves each ran four cold synthetic publishes on each of two distinct Fluid
instances. Each publish included one 12 MiB file, twelve 64 KiB files and unique
HTML, plus an already cached Vercel output config. The workers used current packed
packages and the balanced throttle. Each invocation shared its memory and staging
budgets across four jobs; the same two instances were reused for wave two.

| Wave | Instance | Elapsed  | Peak sampled RSS | Peak staged file bytes |
| ---- | -------- | -------- | ---------------- | ---------------------- |
| 1    | A        | 12.451 s | 144.93 MiB       | 48 MiB                 |
| 1    | B        | 11.634 s | 143.07 MiB       | 48 MiB                 |
| 2    | A        | 11.003 s | 160.24 MiB       | 48 MiB                 |
| 2    | B        | 11.235 s | 159.48 MiB       | 48 MiB                 |

The sixteen publishes uploaded 213,910,096 bytes in 224 successful upload requests.
Independent downloads verified every website file against size, SHA-256 and SHA-1.
Creation returned deployments already READY; additional observed readiness waiting
was 0–1 ms. The 9.121–12.390 s per-job deployment durations include preparation,
transfer and creation, not just provider readiness.

Reservations stayed within 256 MiB memory and 128 MiB disk per process and returned
to zero. Scoped files were removed, all sources closed, and no telemetry dropped.
No 429 occurred. These are short bounded trials, not sustained capacity tests or
fresh-process memory comparisons. Do not sum sampled peaks as though they were a
simultaneous fleet measurement. Account-wide quota coordination remains external.

## Bounded Promise-client live trial (2026-09-26)

The current checkout's Promise client ran ten waves of two concurrent Vercel
publishes, spaced 30 seconds apart, in a newly designated synthetic test project.
The entire trial took 282.855 seconds. Twenty deployments each served exact HTML
and an independently SHA-256-verified 8 MiB payload: 167,772,160 payload bytes total.
Creation calls took 5.176–10.039 seconds. These are observations from one local
process and network, not predictions of Fluid performance or sustained capacity.

The transport recorded 40 successful file uploads, 20 expected missing-content
negotiation responses and 20 successful create responses. No HTTP 429 was observed.
Every wave left the production target unset. Sampled peak RSS was 277.0625 MiB;
transfer reservations were configured for 256 MiB. RSS includes caller-owned input
buffers, runtime and transport allocations, so it is not that reservation budget.
Staging disk was not instrumented, and this is not a fresh-process memory comparison.

An earlier attempt stopped before provider calls because its memory budget was too
small. Another exposed READY-before-serving and stopped on a transient 404. Their
receipts remain separate. The final harness uses the public serving probe, reconciles
interrupted operations and never retries deployment creation blindly. Its results
are in external benchmark receipts; entitlement responses
and the initial failures are in the other `release-*.json` receipts.
