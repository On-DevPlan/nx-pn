/**
 * example-api — host half of the demo dual-half zip plugin (spec §7).
 *
 * Loaded by the host plugin loader (esbuild → import → ctx.plugin).
 * The loader passes the manifest id as the plugin config (`config.name`)
 * and registers the function so cordis's caller-tracker can attribute
 * any `ctx.auditClient` call this half makes back to `example-api`
 * (spec §7.4) — that attribution is the point of this plugin.
 *
 * What it does:
 *   1. Registers a tool endpoint on the host event bus:
 *      `example-api/fetch { url? }` → one audited GET. Anything on the
 *      host side can emit it (`hostCtx.emit('example-api/fetch', …)`).
 *   2. Fires one hello-call at activation (fire-and-forget) so a fresh
 *      upload already shows a record on the audit page.
 *
 * The build (`scripts/build-zip.mjs`) compiles this file to `host.js`
 * with esbuild (bundle, node, esm, external: cordis), which is exactly
 * what the loader's pipeline expects inside the zip.
 */

/** Structural view of the plugin ctx this half relies on. */
interface HostCtx {
  logger: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  /** cordis event bus — handler is auto-disposed with this plugin's fiber. */
  on(event: string, handler: (payload?: unknown) => unknown): unknown
  /** Core unified client (spec §3.1) — every call is audited + attributed. */
  auditClient: {
    get(
      url: string,
      config?: { headers?: Record<string, string>; timeoutMs?: number },
    ): Promise<{ status: number; statusText: string; bodyText: string }>
  }
}

type PluginFn = ((ctx: HostCtx, config?: { name?: string }) => void) & {
  /** cordis inject — delays activation until these services are ready. */
  inject?: string[]
}

const DEFAULT_URL = 'https://httpbin.org/get'
const TOOL_EVENT = 'example-api/fetch'

function pickUrl(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const url = (payload as { url?: unknown }).url
    if (typeof url === 'string' && url.length > 0) return url
  }
  return DEFAULT_URL
}

const plugin = function plugin(ctx: HostCtx, config?: { name?: string }): void {
  const id = config?.name ?? 'example-api'
  ctx.logger.info(`[example-api] host half active (plugin ${id})`)

  // (1) Tool endpoint: `emit('example-api/fetch', { url? })` on the host
  // context triggers one audited request. With no payload it calls the
  // public default URL.
  ctx.on(TOOL_EVENT, (payload?: unknown) => {
    const url = pickUrl(payload)
    ctx.logger.info(`[example-api] tool ${TOOL_EVENT} → GET ${url}`)
    return ctx.auditClient
      .get(url, { headers: { 'user-agent': 'api-audit-example-plugin/1.0.0' } })
      .then((res) => {
        ctx.logger.info(`[example-api] GET ${url} → ${res.status}`)
        return res
      })
      .catch((err: unknown) => {
        // The audit middleware already recorded the failure (status 0);
        // never let the tool crash its caller.
        ctx.logger.warn(`[example-api] GET ${url} failed: ${(err as Error).message}`)
        return undefined
      })
  })

  // (2) Hello at activation — fire-and-forget so the loader never waits
  // on the network. Errors still land in the audit trail as status-0
  // records attributed to this plugin.
  void ctx.auditClient.get(DEFAULT_URL).catch(() => {
    /* recorded by the audit middleware */
  })
}

// cordis reads `inject` off the plugin value; declare our service need.
;(plugin as PluginFn).inject = ['auditClient']

export default plugin
