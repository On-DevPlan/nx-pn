/**
 * echo — host half of the user-driven request tester (spec §7).
 *
 * Unlike example-api (which fires one fixed GET on activation), the
 * echo host half is mostly passive: it registers a tool endpoint that
 * the browser page can trigger, and it does one hello-call at boot
 * so a fresh upload already shows a record on the audit page.
 *
 *   `echo/ping { url }`  → one audited GET (browser page drives it)
 *   `echo/storage.get/put { table?, key, value? }` → this plugin's own
 *     namespace storage (v2 demo — durable, isolated, survives re-install)
 *   boot bootCount       → +1 in the plugin-echo namespace at activation
 *   boot hello-call      → fire-and-forget GET to httpbin.org/get
 *
 * Attribution works the same way: the loader passes the manifest id as
 * the cordis plugin name, and the host's `auditClient` service resolves
 * the calling fiber back to the lifecycle registry to recover it
 * (spec §7.4). The browser page's requests flow through the WS RPC
 * bridge and carry the same `pluginRunId` so the host attributes them
 * to `echo` (see `packages/client/src/audit/client-proxy.ts`).
 *
 * The build (`scripts/build-zip.mjs`) compiles this file to `host.js`
 * with esbuild (bundle, node, esm, external: cordis) — exactly the
 * shape the loader's pipeline expects inside the zip.
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
  /**
   * Plugin namespace storage (v2) — injected by the loader as an own
   * property on this half's ctx (backed by the open `plugin-echo` storage
   * domain under <dataDir>/storage/plugin-echo/). Records survive stop /
   * remove / re-install.
   */
  pluginStorage: {
    ns: string
    table(name: 'settings' | 'cache' | 'state'): {
      get(key: string): unknown
      put(key: string, value: unknown): Promise<void>
      delete(key: string): Promise<boolean>
      update(key: string, fn: (current: unknown) => unknown): Promise<unknown>
      keys(): IterableIterator<string>
      readonly size: number
    }
  }
}

type PluginFn = ((ctx: HostCtx, config?: { name?: string }) => void) & {
  /** cordis inject — delays activation until these services are ready. */
  inject?: string[]
}

const DEFAULT_URL = 'https://httpbin.org/get'
const TOOL_EVENT = 'echo/ping'

function pickUrl(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const url = (payload as { url?: unknown }).url
    if (typeof url === 'string' && url.length > 0) return url
  }
  return DEFAULT_URL
}

const plugin = function plugin(ctx: HostCtx, config?: { name?: string }): void {
  const id = config?.name ?? 'echo'
  ctx.logger.info(`[echo] host half active (plugin ${id})`)

  // (0) Namespace-storage demo (v2): increment a durable boot counter on
  // every activation. The record lives in this plugin's OWN namespace
  // (plugin-echo → <dataDir>/storage/plugin-echo/settings/bootCount.json)
  // and survives stop / remove / re-install — a re-uploaded echo shows
  // the accumulated count, proving per-plugin durable isolation.
  if (ctx.pluginStorage) {
    const settings = ctx.pluginStorage.table('settings')
    const current = settings.get('bootCount')
    const next = (typeof current === 'number' ? current : 0) + 1
    void settings
      .put('bootCount', next)
      .then(() => ctx.logger.info(`[echo] bootCount → ${next} (ns ${ctx.pluginStorage!.ns})`))
      .catch((err: unknown) => {
        // storage failure must never break activation
        ctx.logger.warn(`[echo] bootCount persist failed: ${(err as Error).message}`)
      })
  }

  // (1) Tool endpoint: the browser page emits `echo/ping { url? }` on
  // the host event bus via the WS RPC bridge; this handler converts it
  // into one audited GET. No payload → default URL.
  ctx.on(TOOL_EVENT, (payload?: unknown) => {
    const url = pickUrl(payload)
    ctx.logger.info(`[echo] tool ${TOOL_EVENT} → GET ${url}`)
    return ctx.auditClient
      .get(url, { headers: { 'user-agent': 'api-audit-echo/1.0.0' } })
      .then((res) => {
        ctx.logger.info(`[echo] GET ${url} → ${res.status}`)
        return res
      })
      .catch((err: unknown) => {
        // The audit middleware already recorded the failure (status 0);
        // never let the tool crash its caller.
        ctx.logger.warn(`[echo] GET ${url} failed: ${(err as Error).message}`)
        return undefined
      })
  })

  // (1b) Namespace-storage tool endpoints — the browser page's storage
  // demo rides the same tool bridge (echo/storage.get | put). The page
  // can only reach THIS plugin's namespace: the handle is bound to
  // plugin-echo by the loader.
  ctx.on('echo/storage.get', (payload?: unknown) => {
    if (!ctx.pluginStorage) return { ok: false, error: 'pluginStorage not available' }
    const p = payload as { table?: 'settings' | 'cache' | 'state'; key?: string } | undefined
    const table = p?.table ?? 'settings'
    const key = typeof p?.key === 'string' ? p.key : ''
    if (!key) return { ok: false, error: 'key is required' }
    return { ok: true, data: ctx.pluginStorage.table(table).get(key) }
  })
  ctx.on('echo/storage.put', (payload?: unknown) => {
    if (!ctx.pluginStorage) return { ok: false, error: 'pluginStorage not available' }
    const p = payload as { table?: 'settings' | 'cache' | 'state'; key?: string; value?: unknown } | undefined
    const table = p?.table ?? 'settings'
    const key = typeof p?.key === 'string' ? p.key : ''
    if (!key) return { ok: false, error: 'key is required' }
    return ctx.pluginStorage
      .table(table)
      .put(key, p?.value)
      .then(() => ({ ok: true, data: ctx.pluginStorage!.table(table).get(key) }))
      .catch((err: unknown) => ({ ok: false, error: (err as Error).message }))
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
