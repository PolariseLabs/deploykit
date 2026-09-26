import { Effect, Schema } from "effect"

export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  message: Schema.String
}) {}

/** Keep cancellation active through response consumption; cap remote response allocation. */
export const fetchText = (fetcher: typeof globalThis.fetch, url: string, init: RequestInit = {}) =>
  Effect.tryPromise({
    try: async signal => {
      const response = await fetcher(url, { ...init, signal })
      const reader = response.body?.getReader()
      if (reader === undefined) return { response, text: "" }
      const abort = () => {
        void reader.cancel().catch(() => undefined)
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      const decoder = new TextDecoder()
      let text = ""
      let size = 0
      try {
        while (true) {
          signal.throwIfAborted()
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > 2 * 1024 * 1024) throw new Error("Response limit exceeded")
          text += decoder.decode(next.value, { stream: true })
        }
        return { response, text: text + decoder.decode() }
      } finally {
        signal.removeEventListener("abort", abort)
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    },
    catch: () => new TransportError({ message: "Request failed or response exceeded 2 MiB" })
  })

/** Persist only structured provider codes and missing content hashes, never response text. */
export const safeBody = (text: string): string => {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null
  if (!object(parsed)) return "[redacted]"
  const code = (value: unknown) =>
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[a-zA-Z0-9_]{1,80}$/.test(value)
        ? value
        : undefined
  const error = object(parsed.error) ? parsed.error : parsed
  const missing = error.missing
  return JSON.stringify({
    error: {
      ...(code(error.code) === undefined ? {} : { code: code(error.code) }),
      ...(Array.isArray(missing)
        ? {
            missing: missing
              .filter(
                (value): value is string =>
                  typeof value === "string" && /^[a-f0-9]{40}$/.test(value)
              )
              .slice(0, 20000)
          }
        : {})
    },
    ...(Array.isArray(parsed.errors)
      ? { errors: parsed.errors.filter(object).map(error => ({ code: code(error.code) })) }
      : {})
  })
}

export const retryAfter = (header: string | null): number | undefined => {
  if (header === null) return undefined
  const seconds = Number(header)
  const milliseconds =
    Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined
}

export const responseCode = (text: string): string | undefined => {
  const body = safeBody(text)
  const parsed: unknown = JSON.parse(body.startsWith("{") ? body : "{}")
  if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return undefined
  const error = parsed.error
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" || typeof error.code === "number"
    ? String(error.code)
    : undefined
}
