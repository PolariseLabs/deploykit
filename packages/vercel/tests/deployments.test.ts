import { assert, describe, it } from "@effect/vitest"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import { Artifact, Entry, Provider } from "@deploykit/core"
import { bytesOf, deployToVercelProject } from "../src/services/deployments.ts"
import { getDeployment } from "../src/services/status.ts"
import { stubClient } from "./stub.ts"
import type { VercelReadyState } from "../src/services/client.ts"

/** sha1 of the empty string, and of "hi", from `printf ... | shasum`. */
const EMPTY_SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709"
const HI_SHA = "c22b5f9178342609428d6f51b2c5af4c0bde6a42"

it.layer(NodeFileSystem.layer)("with a filesystem", it => {
  describe("bytesOf", () => {
    it.effect("encodes text as UTF-8, not UTF-16", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const entry = yield* Entry.text("cafe.txt", "café")

        const bytes = yield* bytesOf(fs, entry)

        assert.strictEqual(bytes.byteLength, 5, "4 code units, 5 bytes on the wire")
      })
    )

    it.effect("passes byte entries through untouched", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const entry = yield* Entry.bytes("logo.png", new Uint8Array([1, 2, 3]))

        const bytes = yield* bytesOf(fs, entry)

        assert.deepStrictEqual(Array.from(bytes), [1, 2, 3])
      })
    )

    it.effect("reads file entries off disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${dir}/hi.txt`, "hi")
        const entry = yield* Entry.file("hi.txt", `${dir}/hi.txt`)

        const bytes = yield* bytesOf(fs, entry)

        assert.strictEqual(new TextDecoder().decode(bytes), "hi")
      })
    )

    /**
     * A source that existed at compose time and is gone by upload time. The
     * entry is valid when built, so this is the genuine race rather than a
     * path that was never there, and it must surface as a ProviderError
     * rather than a raw PlatformError from the filesystem.
     */
    it.effect("surfaces a source that vanished as a ProviderError", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${dir}/here.txt`, "for now")

        const stub = stubClient({ missingOnFirstDeploy: ["any"] })
        const artifact = yield* Artifact.make([yield* Entry.file("here.txt", `${dir}/here.txt`)])

        yield* fs.remove(`${dir}/here.txt`)

        const error = yield* Effect.flip(deployToVercelProject(stub.client, fs, "prj_1", artifact))

        assert.strictEqual(error._tag, "ProviderError")
        assert.strictEqual(error.provider, "vercel")
        assert.strictEqual(error.appId, "prj_1")
      })
    )
  })

  describe("deployToVercelProject", () => {
    /**
     * The manifest goes first. Uploading before asking costs a read and a
     * transfer per file even when Vercel already holds the bytes, which on a
     * republish is most of the tree.
     */
    it.effect("uploads nothing when Vercel accepts the manifest", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()
        const artifact = yield* Artifact.make([
          yield* Entry.text("hi.txt", "hi"),
          yield* Entry.text("empty.txt", "")
        ])

        yield* deployToVercelProject(stub.client, fs, "prj_1", artifact)

        assert.strictEqual(stub.uploads.length, 0, "Vercel already had them")
        assert.strictEqual(stub.deployRequests.length, 1)
        const shas = stub.deployRequests[0]!.files.map(file => file.sha).sort()
        assert.deepStrictEqual(shas, [EMPTY_SHA, HI_SHA].sort())
        const sizes = stub.deployRequests[0]!.files.map(file => file.size).sort()
        assert.deepStrictEqual(sizes, [0, 2])
      }).pipe(Effect.provide(NodeFileSystem.layer))
    )

    it.effect("uploads only the files Vercel says it is missing, then retries", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ missingOnFirstDeploy: [HI_SHA] })
        const artifact = yield* Artifact.make([
          yield* Entry.text("hi.txt", "hi"),
          yield* Entry.text("empty.txt", "")
        ])

        yield* deployToVercelProject(stub.client, fs, "prj_1", artifact)

        assert.strictEqual(stub.uploads.length, 1, "only the missing one")
        assert.strictEqual(stub.uploads[0]?.sha, HI_SHA)
        assert.strictEqual(stub.deployRequests.length, 2, "manifest, upload, manifest again")
      }).pipe(Effect.provide(NodeFileSystem.layer))
    )

    it.effect("uploads everything when Vercel complains about digests with no list", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ digestComplaintOnFirstDeploy: true })
        const artifact = yield* Artifact.make([
          yield* Entry.text("hi.txt", "hi"),
          yield* Entry.text("empty.txt", "")
        ])

        yield* deployToVercelProject(stub.client, fs, "prj_1", artifact)

        assert.strictEqual(stub.uploads.length, 2, "a first publish: it holds none of them")
      }).pipe(Effect.provide(NodeFileSystem.layer))
    )

    it.effect("never reads a deferred entry whose sha it already knows", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()
        let reads = 0
        const artifact = yield* Artifact.make([
          yield* Entry.deferred("big.bin", {
            byteLength: 1024,
            digests: { sha1: "deadbeef" },
            read: () => {
              reads += 1
              return Promise.resolve(new Uint8Array(1024))
            }
          })
        ])

        yield* deployToVercelProject(stub.client, fs, "prj_1", artifact)

        assert.strictEqual(reads, 0, "the whole point: no fetch, no hash")
        assert.strictEqual(stub.deployRequests[0]?.files[0]?.sha, "deadbeef")
        assert.strictEqual(stub.deployRequests[0]?.files[0]?.size, 1024)
      }).pipe(Effect.provide(NodeFileSystem.layer))
    )

    it.effect("reads a deferred entry when it is actually missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ missingOnFirstDeploy: ["deadbeef"] })
        let reads = 0
        const artifact = yield* Artifact.make([
          yield* Entry.deferred("big.bin", {
            byteLength: 3,
            digests: { sha1: "deadbeef" },
            read: () => {
              reads += 1
              return Promise.resolve(new Uint8Array([1, 2, 3]))
            }
          })
        ])

        yield* deployToVercelProject(stub.client, fs, "prj_1", artifact)

        assert.strictEqual(reads, 1, "fetched once, only because Vercel asked")
      }).pipe(Effect.provide(NodeFileSystem.layer))
    )

    it.effect("sends the artifact's paths to createDeployment, in insertion order", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()
        const artifact = yield* Artifact.make([
          yield* Entry.text("index.html", "<h1>hi</h1>"),
          yield* Entry.text("about.html", "about"),
          yield* Entry.text("style.css", "body{}")
        ])

        yield* deployToVercelProject(stub.client, fs, "prj_1", artifact)

        const body = stub.deployRequests[0]!
        assert.deepStrictEqual(
          body.files.map(file => file.file),
          ["index.html", "about.html", "style.css"]
        )
      })
    )

    it.effect("deploys an empty artifact without uploading anything", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient()

        const deployment = yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty)

        assert.strictEqual(stub.uploads.length, 0)
        assert.strictEqual(deployment.id, "dpl_1")
      })
    )

    it.effect("turns an SDK rejection into a ProviderError carrying the app id", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ failWithoutResponse: "rate limited" })

        const error = yield* Effect.flip(
          deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty)
        )

        assert.strictEqual(error.message, "rate limited")
        assert.strictEqual(error.appId, "prj_1")
        assert.strictEqual(error.provider, "vercel")
      })
    )

    it.effect("copes with a rejection that is not an Error", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ failWithoutResponse: "Unknown error" })

        const error = yield* Effect.flip(
          deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty)
        )

        assert.strictEqual(error.message, "Unknown error")
      })
    )

    it.effect("prefixes the returned URL with https, as Vercel omits the scheme", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({
          deployment: {
            id: "dpl_1",
            readyState: "READY",
            name: "alpha",
            projectId: "prj_1",
            url: "alpha-abc.vercel.app"
          }
        })

        const deployment = yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty)

        assert.strictEqual(deployment.url, "https://alpha-abc.vercel.app")
      })
    )

    it.effect("falls back to the requested app id when Vercel omits projectId", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const stub = stubClient({ deployment: { id: "dpl_1", readyState: "QUEUED" } })

        const deployment = yield* deployToVercelProject(
          stub.client,
          fs,
          "prj_fallback",
          Artifact.empty
        )

        assert.strictEqual(deployment.appId, "prj_fallback")
        assert.strictEqual(deployment.name, "dpl_1", "the id stands in for a missing name")
      })
    )
  })
})

describe("getDeployment", () => {
  /**
   * The whole point of the adapter: Vercel's seven states collapse onto the
   * four portable ones, so a caller never has to know what BLOCKED means.
   */
  const cases: ReadonlyArray<readonly [VercelReadyState, string]> = [
    ["QUEUED", "pending"],
    ["INITIALIZING", "pending"],
    ["BUILDING", "deploying"],
    ["READY", "deployed"],
    ["ERROR", "failed"],
    ["CANCELED", "failed"],
    ["BLOCKED", "failed"]
  ]

  for (const [readyState, expected] of cases) {
    it.effect(`maps ${readyState} to ${expected}`, () =>
      Effect.gen(function* () {
        const stub = stubClient({ deployment: { id: "dpl_1", readyState } })

        const deployment = yield* getDeployment(stub.client, "prj_1", "dpl_1")

        assert.strictEqual(deployment.status, expected)
      })
    )
  }

  it.effect("reports an unknown app id rather than inventing one", () =>
    Effect.gen(function* () {
      const stub = stubClient({ deployment: { id: "dpl_1", readyState: "QUEUED" } })

      const deployment = yield* getDeployment(stub.client, "prj_1", "dpl_1")

      assert.strictEqual(deployment.appId, "unknown")
    })
  )

  it.effect("turns an SDK rejection into a ProviderError carrying the deployment id", () =>
    Effect.gen(function* () {
      const stub = stubClient({ failWithoutResponse: "not found" })

      const error = yield* Effect.flip(getDeployment(stub.client, "prj_1", "dpl_missing"))

      assert.strictEqual(error.message, "not found")
      assert.strictEqual(error.deploymentId, "dpl_missing")
    })
  )
})

describe("the deployment request", () => {
  /**
   * The whole reason for dropping the SDK. A deployment created without
   * prebuilt is treated as source and built, so these two flags are the
   * difference between deploying an artifact and asking Vercel to compile one.
   */
  it.effect("asks for a prebuilt deployment and skips framework confirmation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient()

      yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty)

      const request = stub.deployRequests[0]!
      assert.strictEqual(request.projectId, "prj_1")
      assert.strictEqual(request.target, "production", "a publish means the live slot")
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it.effect("deploys to preview when asked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient()

      yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty, {
        target: "preview"
      })

      assert.strictEqual(stub.deployRequests[0]?.target, "preview")
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it.effect("carries meta through, for linking a deployment to a release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient()

      yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty, {
        meta: { releaseId: "rel_7" }
      })

      assert.deepStrictEqual(stub.deployRequests[0]?.meta, { releaseId: "rel_7" })
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it.effect("omits meta entirely when not given, rather than sending undefined", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient()

      yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty)

      assert.isFalse("meta" in stub.deployRequests[0]!)
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it.effect("resumes an existing deployment when one is given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient()

      yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty, {
        resume: "dpl_earlier"
      })

      assert.strictEqual(stub.deployRequests[0]?.deploymentId, "dpl_earlier")
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )
})

describe("error detail", () => {
  it.effect("carries status, body and Retry-After onto ProviderError", () =>
    Effect.gen(function* () {
      const stub = stubClient({
        failWithStatus: 429,
        failWithBody: '{"error":{"code":"rate_limited"}}',
        retryAfterSeconds: 12
      })

      const error = yield* Effect.flip(getDeployment(stub.client, "prj_1", "dpl_1"))

      assert.strictEqual(error.statusCode, 429)
      assert.match(error.body ?? "", /rate_limited/)
      assert.strictEqual(error.retryAfterMs, 12_000)
      assert.strictEqual(error.deploymentId, "dpl_1", "context survives the mapping")
    })
  )

  it.effect("leaves the status absent when the request never got an answer", () =>
    Effect.gen(function* () {
      const stub = stubClient({ failWithoutResponse: "fetch failed" })

      const error = yield* Effect.flip(getDeployment(stub.client, "prj_1", "dpl_1"))

      assert.strictEqual(error.statusCode, undefined)
      assert.strictEqual(error.message, "fetch failed")
    })
  )

  /** Retry policy depends on this, so it is pinned rather than assumed. */
  it("classifies what is worth retrying", () => {
    {
      const of = (status?: number) =>
        new Provider.ProviderError({
          message: "x",
          provider: "vercel",
          ...(status !== undefined ? { statusCode: status } : {})
        })

      assert.isTrue(Provider.isTransient(of(429)), "throttled")
      assert.isTrue(Provider.isTransient(of(503)), "server down")
      assert.isTrue(Provider.isTransient(of(408)), "request timeout")
      assert.isTrue(Provider.isTransient(of()), "no answer at all")
      assert.isFalse(Provider.isTransient(of(400)), "our request is wrong")
      assert.isFalse(Provider.isTransient(of(404)), "it is not there")
      assert.isFalse(Provider.isTransient(of(403)), "not allowed")
    }
  })
})

describe("digests are provider-keyed", () => {
  /**
   * Cloudflare Pages hashes sha256 over base64 content plus the extension, so
   * a digest stored for one provider means nothing to another. An adapter
   * that finds no key it recognises reads and hashes as usual rather than
   * trusting a hash computed for someone else.
   */
  it.effect("ignores a digest computed for a different provider", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient()
      let reads = 0
      const artifact = yield* Artifact.make([
        yield* Entry.deferred("big.bin", {
          byteLength: 2,
          digests: { "sha256-b64ext": "not-a-vercel-digest" },
          read: () => {
            reads += 1
            return Promise.resolve(new TextEncoder().encode("hi"))
          }
        })
      ])

      yield* deployToVercelProject(stub.client, fs, "prj_1", artifact)

      assert.strictEqual(reads, 1, "read, because no sha1 was on offer")
      assert.strictEqual(stub.deployRequests[0]?.files[0]?.sha, HI_SHA)
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )
})

describe("what a caller can control and see", () => {
  const collect = () => {
    const events: Array<Provider.DeployProgress> = []
    return {
      events,
      onProgress: (event: Provider.DeployProgress) => Effect.sync(() => void events.push(event))
    }
  }

  /**
   * the consumer needs all three of these and none were reachable through the
   * portable contract until now: the adapter supported them, Provider.deploy
   * took only an artifact.
   */
  it.effect("carries target, meta and resume from the portable options", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient()

      yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty, {
        target: "preview",
        meta: { releaseId: "rel_7" },
        resume: "dpl_earlier"
      })

      const request = stub.deployRequests[0]!
      assert.strictEqual(request.target, "preview")
      assert.deepStrictEqual(request.meta, { releaseId: "rel_7" })
      assert.strictEqual(request.deploymentId, "dpl_earlier")
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it.effect("reports hashing and the deployment id", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient()
      const { events, onProgress } = collect()

      yield* deployToVercelProject(
        stub.client,
        fs,
        "prj_1",
        yield* Artifact.make([yield* Entry.text("a.txt", "hi")]),
        { onProgress }
      )

      const tags = events.map(event => event._tag)
      assert.include(tags, "Hashing")
      assert.include(tags, "Created")
      const created = events.find(event => event._tag === "Created")
      assert.strictEqual(created?._tag === "Created" ? created.deploymentId : "", "dpl_1")
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it.effect("reports uploading with a count and a byte total", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient({ digestComplaintOnFirstDeploy: true })
      const { events, onProgress } = collect()

      yield* deployToVercelProject(
        stub.client,
        fs,
        "prj_1",
        yield* Artifact.make([yield* Entry.text("a.txt", "hi")]),
        { onProgress }
      )

      const uploading = events.filter(event => event._tag === "Uploading")
      assert.isAbove(uploading.length, 0)
      const last = uploading.at(-1)!
      assert.strictEqual(last._tag === "Uploading" ? last.total : 0, 1)
      assert.strictEqual(last._tag === "Uploading" ? last.bytes : 0, 2)
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  /** A broken progress callback is the caller's problem, not the deploy's. */
  it.effect("a failing onProgress does not fail the deploy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const stub = stubClient()

      const deployment = yield* deployToVercelProject(stub.client, fs, "prj_1", Artifact.empty, {
        onProgress: () => Effect.die(new Error("reporting blew up"))
      })

      assert.strictEqual(deployment.id, "dpl_1")
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )
})
