/**
 * Turning a Worker script into the `_worker.bundle` Pages wants.
 *
 * A Pages Function is not an asset. Uploading `_worker.js` through the asset
 * manifest deploys successfully and does nothing: tested against a real
 * account, the route fell through to the static index.html. Pages takes the
 * Worker as a separate multipart field on the deployment itself.
 *
 * That field is not the script either. It is a whole Workers upload form,
 * serialised: a `metadata` part naming the entry module, plus one part per
 * module. `new Response(form).blob()` is how wrangler serialises it, and is
 * the only reason this is a dozen lines rather than a multipart encoder.
 */

/** ESM is the only module type Pages accepts as an entry point. */
const MODULE_TYPE = "application/javascript+module"

export interface WorkerModule {
  /** The name the entry module imports it by. */
  readonly name: string
  readonly content: string
}

export interface WorkerBundleOptions {
  /** The entry module. Its name is what `main_module` points at. */
  readonly main: WorkerModule
  /** Anything the entry imports. */
  readonly modules?: ReadonlyArray<WorkerModule>
  /**
   * Which runtime semantics to pin. Cloudflare dates its breaking changes, so
   * an absent one means "whatever is current", which is a deployment that
   * changes behaviour under you.
   */
  readonly compatibilityDate?: string
  readonly compatibilityFlags?: ReadonlyArray<string>
}

export const workerBundle = async (options: WorkerBundleOptions): Promise<Blob> => {
  const form = new FormData()

  form.set(
    "metadata",
    JSON.stringify({
      main_module: options.main.name,
      compatibility_date: options.compatibilityDate ?? "2024-11-01",
      compatibility_flags: options.compatibilityFlags ?? []
    })
  )

  for (const module of [options.main, ...(options.modules ?? [])]) {
    form.set(module.name, new File([module.content], module.name, { type: MODULE_TYPE }))
  }

  return new Response(form).blob()
}

/** Where a caller puts the Worker in the artifact, matching Pages on disk. */
export const WORKER_PATH = "_worker.js"
