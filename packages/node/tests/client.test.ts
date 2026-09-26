import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import {
  AbortError,
  ClientClosedError,
  ProviderError,
  UnsupportedError,
  artifactFromFiles
} from "../src/index.ts"
import { createClient } from "../src/vercel.ts"
import { createClient as createPages } from "../src/cloudflare.ts"

const digest = (algorithm: string, text: string) => createHash(algorithm).update(text).digest("hex")
const manifest = {
  version: 1,
  entries: [
    {
      path: "index.html",
      source: "blob:index",
      byteLength: 1,
      sha256: digest("sha256", "x"),
      fingerprints: [{ recipe: "vercel-sha1-v1", context: "", value: digest("sha1", "x") }]
    }
  ]
}
const missing = () =>
  Response.json(
    { error: { code: "missing_files", missing: [digest("sha1", "x")] } },
    { status: 400 }
  )
const created = () =>
  Response.json({ id: "dpl_1", projectId: "app", readyState: "READY", target: "production" })

function gate() {
  let resolve = () => {}
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test("Promise calls use the real adapter and isolate callback failures", async () => {
  let uploaded = false
  let creates = 0
  let events = 0
  const client = createClient({
    token: "test",
    onEvent: () => {
      events++
      throw new Error("export failed")
    },
    fetch: async (input, init) => {
      if (String(input).includes("/v2/files")) {
        expect(init?.body).toEqual(new TextEncoder().encode("x"))
        uploaded = true
        return new Response(null)
      }
      const body = JSON.parse(String(init?.body))
      expect(body.autoAssignCustomDomains).toBe(false)
      expect(body.meta.deploykitOperationId).toBe("publish-1")
      creates++
      return uploaded ? created() : missing()
    }
  })
  try {
    const artifact = await artifactFromFiles([{ path: "index.html", text: "x" }])
    const result = await client.deploy("app", artifact, {
      target: "production",
      activation: "deferred",
      operationId: "publish-1",
      uploadConcurrency: 2,
      onProgress: async () => {
        throw new Error("UI failed")
      }
    })
    expect(result.id).toBe("dpl_1")
    expect(creates).toBe(2)
    expect(events).toBeGreaterThan(0)
  } finally {
    await client.close()
  }
})

test("typed provider errors reach Promise callers unchanged", async () => {
  const client = createClient({
    token: "test",
    fetch: async () =>
      Response.json({ error: { code: "invalid_password_protection" } }, { status: 428 })
  })
  try {
    await expect(
      client.setAccess("app", { _tag: "Password", password: "secret" })
    ).rejects.toBeInstanceOf(ProviderError)
    await expect(
      client.setAccess("app", { _tag: "Password", password: "secret" })
    ).rejects.toMatchObject({
      _tag: "ProviderError",
      outcome: "rejected",
      recovery: "fix-input"
    })
  } finally {
    await client.close()
  }
})

test("lost creation stays ambiguous without wrapper retries", async () => {
  let calls = 0
  const client = createClient({
    token: "test",
    fetch: async () => {
      calls++
      throw new Error("lost response")
    }
  })
  try {
    await expect(client.deploy("app", await artifactFromFiles([]))).rejects.toMatchObject({
      _tag: "ProviderError",
      outcome: "unknown",
      recovery: "reconcile"
    })
    expect(calls).toBe(1)
  } finally {
    await client.close()
  }
})

test("aborting a source closes it, aborts its signal and permits a later publish", async () => {
  const opened = gate()
  let cancelled = false
  let sourceSignal: AbortSignal | undefined
  let uploads = 0
  let accepted = 0
  const client = createClient({
    token: "test",
    memoryBudgetBytes: 16 * 1024 * 1024,
    fetch: async input => {
      if (String(input).includes("/v2/files")) {
        uploads++
        return new Response(null)
      }
      if (uploads === 0) return missing()
      accepted++
      return created()
    }
  })
  const controller = new AbortController()
  try {
    const pending = client.deployManifest(
      "app",
      manifest,
      async (_reference, signal) => {
        sourceSignal = signal
        return new ReadableStream({
          pull: () => {
            opened.resolve()
          },
          cancel: () => {
            cancelled = true
          }
        })
      },
      { signal: controller.signal }
    )
    const rejected = expect(pending).rejects.toBeInstanceOf(AbortError)
    await opened.promise
    controller.abort()
    await rejected
    expect(cancelled).toBe(true)
    expect(sourceSignal?.aborted).toBe(true)
    expect(uploads).toBe(0)
    expect(accepted).toBe(0)
    const result = await client.deployManifest("app", manifest, async () => new Response("x").body!)
    expect(result.id).toBe("dpl_1")
    expect(uploads).toBe(1)
  } finally {
    await client.close()
  }
})

test("close aborts active uploads, waits for cleanup and rejects new work", async () => {
  const uploading = gate()
  let aborted = false
  const client = createClient({
    token: "test",
    fetch: async (input, init) => {
      if (!String(input).includes("/v2/files")) return missing()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        })
        uploading.resolve()
      })
    }
  })
  const pending = client.deployManifest("app", manifest, async () => new Response("x").body!)
  const rejected = expect(pending).rejects.toBeInstanceOf(AbortError)
  await uploading.promise
  await Promise.all([client.close(), client.close()])
  await rejected
  expect(aborted).toBe(true)
  await expect(client.getApp("app")).rejects.toBeInstanceOf(ClientClosedError)
})

test("Cloudflare keeps its unsupported deferred activation behaviour", async () => {
  let requests = 0
  const client = createPages({
    apiToken: "test",
    accountId: "account",
    fetch: async () => {
      requests++
      return new Response(null)
    }
  })
  try {
    expect((await client.getCapabilities()).deferredActivation).toBe(false)
    await expect(
      client.deploy("app", await artifactFromFiles([{ path: "index.html", text: "x" }]), {
        activation: "deferred"
      })
    ).rejects.toBeInstanceOf(UnsupportedError)
    expect(requests).toBe(0)
  } finally {
    await client.close()
  }
})

test("overlapping publishes share the client's byte budget", async () => {
  let active = 0
  let peak = 0
  let uploads = 0
  const client = createClient({
    token: "test",
    memoryBudgetBytes: 16 * 1024 * 1024,
    fetch: async input => {
      if (!String(input).includes("/v2/files")) return uploads >= 2 ? created() : missing()
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      uploads++
      active--
      return new Response(null)
    }
  })
  try {
    await Promise.all(
      [0, 1].map(() => client.deployManifest("app", manifest, async () => new Response("x").body!))
    )
    expect(peak).toBe(1)
    expect(uploads).toBeGreaterThanOrEqual(2)
  } finally {
    await client.close()
  }
})

test("an already aborted call never opens a source or sends HTTP", async () => {
  let calls = 0
  const client = createClient({
    token: "test",
    fetch: async () => {
      calls++
      return created()
    }
  })
  try {
    await expect(
      client.deployManifest(
        "app",
        manifest,
        async () => {
          calls++
          return new Response("x").body!
        },
        { signal: AbortSignal.abort() }
      )
    ).rejects.toBeInstanceOf(AbortError)
    expect(calls).toBe(0)
  } finally {
    await client.close()
  }
})
