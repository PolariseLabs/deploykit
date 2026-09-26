import { createServer } from "node:http"
import { Effect } from "effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { makeCollector } from "./collector.js"
import type { Options } from "./collector.js"
import { page } from "./page.js"

export { makeCollector } from "./collector.js"
export type { Options, RecordedEvent, Run } from "./collector.js"

/** Keep the enclosing scope open for as long as the local dashboard is needed. */
export const make = (options: Options & { readonly port?: number } = {}) =>
  Effect.gen(function* () {
    const collector = yield* makeCollector(options)
    const server = yield* NodeHttpServer.make(createServer, {
      host: "127.0.0.1",
      port: options.port ?? 0
    })
    if (server.address._tag !== "TcpAddress")
      return yield* Effect.die(new Error("Expected a TCP server"))
    const host = `127.0.0.1:${server.address.port}`
    const url = `http://${host}`
    const nonce = crypto.randomUUID()
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`
    }
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (
          request.headers.host !== host ||
          (request.headers.origin !== undefined && request.headers.origin !== url)
        )
          return HttpServerResponse.empty({ status: 403 })
        if (request.method !== "GET") return HttpServerResponse.empty({ status: 405 })
        if (request.url === "/")
          return HttpServerResponse.text(page(nonce), { headers, contentType: "text/html" })
        if (request.url === "/events")
          return yield* HttpServerResponse.json(yield* collector.snapshot, { headers })
        return HttpServerResponse.empty({ status: 404 })
      })
    )
    return { ...collector, url }
  })
