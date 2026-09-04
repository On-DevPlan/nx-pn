/**
 * @flowot/nx-pn-host — Node-side runtime. Spec §4.
 *
 * Public API:
 *   - startHost({ port, dataDir }) → boots HTTP + WS + cordis; returns
 *     a handle exposing the underlying server / client / port.
 *   - stopHost(handle) → graceful shutdown.
 */

import { CordisContext, type Context } from './cordis/cordis-shim.js'

import { join } from 'node:path'
import { Storage } from '@flowot/nx-pn-storage'
import { JsonStorageBackend } from '@flowot/nx-pn-storage-json'
import { DomainFacility, type Domain, type DomainSpec } from '@flowot/nx-pn-storage-domain'

import { startHttpServer, type StartedHttp } from './server/http-server.js'
import { WsHostServer } from './ws/ws-server.js'
import { BrowserHalfPusher } from './ws/browser-half-pusher.js'
import { AuditRingBuffer } from './client/ring-buffer.js'
import { HostAuditClient } from './client/audit-client.js'
import type { AuditRecord } from './client/audit-record.js'
import { PluginLifecycle } from './plugins/lifecycle.js'
import { PluginLoader } from './plugins/loader.js'
import {
  npmInstallPlugin,
  restartNpmPlugins,
  uninstallNpmPlugin,
} from './plugins/installer.js'
import {
  installCoreServices,
  setHostDeps,
  clearHostDeps,
  type HostDeps,
} from './cordis/host-context.js'
import { AuditPageHostPlugin } from './cordis/builtin-plugins/audit-page.js'
import { ReplayPageHostPlugin } from './cordis/builtin-plugins/replay-page.js'
import { PluginsPageHostPlugin } from './cordis/builtin-plugins/plugins-page.js'
import { auditSpec, type AuditSpec } from './domains/audit-domain.js'
import { pluginsSpec } from './domains/plugins-domain.js'
import { credentialsSpec, type CredentialsSpec } from './domains/credentials-domain.js'
import { pluginNsSpec, PLUGIN_NS_TABLES } from './cordis/plugin-storage-service.js'

export interface StartHostOptions {
  /** 0 = ephemeral port. */
  port?: number
  /** Binds interface. */
  host?: string
  /** Where to persist plugin zips + compiled artefacts. */
  dataDir: string
  /** Whether to scan dataDir/plugins on boot. Default true. */
  restartFromDataDir?: boolean
}

export interface StartedHost {
  ctx: Context
  http: StartedHttp
  ws: WsHostServer
  client: HostAuditClient
  buffer: AuditRingBuffer<AuditRecord>
  lifecycle: PluginLifecycle
  loader: PluginLoader
  port: number
  dataDir: string
  /** Opened storage domains (diagnostics / tests). */
  auditDomain: Domain<AuditSpec>
  pluginsDomain: Domain<typeof pluginsSpec>
  credentialsDomain: Domain<CredentialsSpec>
  stop(): Promise<void>
}

export async function startHost(opts: StartHostOptions): Promise<StartedHost> {
  const ctx = new CordisContext()
  const lifecycle = new PluginLifecycle()

  // The ring buffer's onPush broadcasts new records over WS. Construct the
  // ws server first (deferred `configureConnection` hook), then the buffer.
  const ws = new WsHostServer({ path: '/ws' })
  const browserHalfPusher = new BrowserHalfPusher({ ws })

  // Wire the pusher into the lifecycle so `lifecycle.remove(runId)`
  // broadcasts `browser-half.retract { id, pluginRunId }` to every
  // connected browser. This makes re-upload dedup (loader.ts) and npm
  // upgrade dedup (installer.ts) drop the old browser half + pages
  // atomically with the host half's disposal, preventing stale
  // pluginRunIds from shadowing the new run on the client side.
  lifecycle.setBrowserHalfPusher(browserHalfPusher)

  const broadcast = (op: import('./ws/rpc-bridge.js').RpcOp, payload: unknown): void => {
    ws.forEach((_s, bridge) => bridge.sendNotification(op, payload))
  }

  // ── storage assembly (v1 durable + v2 plugin ns) ─────────────────────
  // Everything durable lives under <dataDir>/storage: the audit trail, the
  // npm ledger, resolved credentials, and one `plugin-<id>` namespace per
  // loaded plugin. The facility stays a local — `storage.domain` is typed
  // `never` (StorageForms has no `domain` member in the pure-lib port), so
  // the host holds it directly.
  const storage = new Storage()
  const jsonBackend = new JsonStorageBackend(join(opts.dataDir, 'storage'))
  const unregisterJsonBackend = storage.backend.register('json', jsonBackend)
  const storageLogger = {
    warn: (m: string) => ctx.logger.warn(m),
    error: (m: string) => ctx.logger.error(m),
  }
  const facility = new DomainFacility({
    storage,
    backend: 'json',
    // domain/changed notifications are a future WS push surface (v1: no-op)
    emit: () => {},
    logger: storageLogger,
  })
  const auditDomain = await facility.open(auditSpec)
  const pluginsDomain = await facility.open(pluginsSpec)
  const credentialsDomain = await facility.open(credentialsSpec)

  // Plugin ns storage (v2): lifecycle.register opens `plugin-<id>` domains
  // through this opener; loader / installer await the open before the
  // plugin's fiber activates (see lifecycle.ts).
  lifecycle.setPluginNsOpener((id) => facility.open(pluginNsSpec(id)))

  // Rebuild the live buffer from the durable audit trail (ids map 1:1 to
  // the persisted `String(id)` keys; the buffer keeps only its capacity of
  // newest records but lastId resumes from the trail's maximum). rebuild
  // never fires onPush — history is not re-broadcast.
  const buffer = new AuditRingBuffer<AuditRecord>({
    onPush: (record) => broadcast('audit.append', record),
  })
  {
    const existing: AuditRecord[] = []
    for (const [key, value] of auditDomain.table('records').entries()) {
      existing.push({ ...(value as AuditRecord), id: Number(key) })
    }
    buffer.rebuild(existing)
  }
  // Durable-first audit pipeline: every record is persisted to the audit
  // domain BEFORE it enters the buffer / broadcasts (a persist failure
  // drops the record from both — see audit-middleware.ts).
  const persistAudit = (record: AuditRecord): Promise<void> =>
    auditDomain.table('records').put(String(record.id), record)
  const client = new HostAuditClient({ buffer, persist: persistAudit })
  const loader = new PluginLoader({ dataDir: opts.dataDir, ctx, lifecycle })
  const depsBag: HostDeps = { ringBuffer: buffer, client, loader, lifecycle, credentialsDomain, auditDomain }

  setHostDeps(depsBag)

  // §4.5.4 — per-connection snapshot push + reconnect reconciliation.
  const snapshot = (bridge: import('./ws/rpc-bridge.js').RpcBridge, sinceId = 0) => ({
    generation: bridge.generation,
    auditLastId: buffer.lastId,
    records: buffer.since(sinceId),
    plugins: lifecycle.list().map((e) => ({
      id: e.id,
      pluginRunId: e.pluginRunId,
      manifest: e.manifest,
    })),
  })
  /**
   * Browser-side `rpc.invoke` dispatcher (spec §5.5). A plugin browser
   * half's `ctx.auditClient.get/post/...` rides the WS bridge as an
   * `rpc.invoke` frame carrying its pluginRunId. Resolve that run id to
   * the plugin name (spec §7.4 attribution), run the audited request,
   * and reply with the AuditResponse envelope the browser proxy parses.
   */
  async function handleBrowserInvoke(
    bridge: import('./ws/rpc-bridge.js').RpcBridge,
    frame: import('./ws/rpc-bridge.js').RpcFrame,
  ): Promise<void> {
    const payload = (frame.payload ?? {}) as {
      method?: unknown
      url?: unknown
      body?: unknown
      pluginRunId?: unknown
      config?: Record<string, unknown>
    }
    const method = String(payload.method ?? 'GET').toUpperCase()
    const url = typeof payload.url === 'string' ? payload.url : ''
    const runId = typeof payload.pluginRunId === 'string' ? payload.pluginRunId : undefined
    const entry = runId ? lifecycle.byRunId(runId) : undefined
    const base = (payload.config ?? {}) as { headers?: Record<string, string>; timeoutMs?: number }
    const config = entry ? { ...base, initiator: entry.id } : base
    try {
      let res: import('@flowot/nx-pn-core').AuditResponse
      switch (method) {
        case 'GET':
          res = await client.get(url, config)
          break
        case 'POST':
          res = await client.post(url, payload.body, config)
          break
        case 'PUT':
          res = await client.put(url, payload.body, config)
          break
        case 'PATCH':
          res = await client.patch(url, payload.body, config)
          break
        case 'DELETE':
          res = await client.delete(url, config)
          break
        default:
          bridge.sendResult(frame.requestId, {
            ok: false,
            error: { code: 'rpc/unsupported-method', message: `unsupported method ${method}` },
          }, frame.generation)
          return
      }
      bridge.sendResult(frame.requestId, { ok: true, data: res }, frame.generation)
    } catch (err) {
      // The audit middleware already recorded the failure (status 0); the
      // caller still gets a structured error so the page can render it.
      bridge.sendResult(frame.requestId, {
        ok: false,
        error: { code: 'rpc/invoke-error', message: err instanceof Error ? err.message : String(err) },
      }, frame.generation)
    }
  }

  /**
   * Browser-side `tool.invoke` dispatcher — the browser→host tool-event
   * bridge. A plugin browser half's `ctx.hostCall('<plugin>/<action>',
   * payload)` rides the WS bridge as a `tool.invoke` frame; dispatch it
   * on the HOST cordis context where the plugin's host half registered
   * its handler via `ctx.on('<plugin>/<action>', ...)`.
   *
   * Dispatch mode: cordis `emit` is fire-and-forget (returns void, no
   * await), so the result-returning `serial` dispatch is used — it
   * awaits each handler and resolves with the first bailling (defined)
   * result, i.e. the host half's ApiResult. No listener ⇒ `undefined`.
   *
   * Attribution: `pluginRunId` is resolved for logging only — the event
   * namespace itself is plugin-owned, so an unknown runId still
   * dispatches. The tool.invoke frame itself goes through NO audit
   * middleware; any auditClient call the handler makes is audited with
   * initiator attribution as usual.
   *
   * Reply convention (matches `rpc.invoke`): rpc-level `{ ok: true,
   * data: <ApiResult> }` so structured handler errors (including the
   * no-handler degradation) survive the client pending table verbatim;
   * unexpected dispatch faults use rpc-level `{ ok: false, error: {
   * code, message } }` which the client rejects as an RpcError.
   */
  async function handleToolInvoke(
    bridge: import('./ws/rpc-bridge.js').RpcBridge,
    frame: import('./ws/rpc-bridge.js').RpcFrame,
  ): Promise<void> {
    const payload = (frame.payload ?? {}) as { pluginRunId?: unknown; event?: unknown; payload?: unknown }
    const event = typeof payload.event === 'string' ? payload.event : ''
    const runId = typeof payload.pluginRunId === 'string' ? payload.pluginRunId : ''
    const reply = (result: unknown): void => {
      bridge.sendResult(frame.requestId, { ok: true, data: result }, frame.generation)
    }
    try {
      if (!event) {
        reply({ ok: false, error: 'tool.invoke: event must be a non-empty string' })
        return
      }
      const entry = runId ? lifecycle.byRunId(runId) : undefined
      ctx.logger.info(`[tool] ${event} via ${entry ? `${runId} (${entry.id})` : runId || 'unknown'}`)
      // `ctx.serial` comes from cordis's reflect mixin accessor, which
      // returns the EventsService method already bound to the service —
      // call it as-is (rebinding to ctx would break its `_hooks` lookup).
      const serial = (ctx as unknown as {
        serial: (name: string, ...args: unknown[]) => Promise<unknown>
      }).serial
      const raw = await serial(event, payload.payload)
      // Defensive: if the dispatch layer ever aggregates into an array,
      // prefer the first defined entry.
      const result = Array.isArray(raw) ? raw.find((r) => r !== undefined) : raw
      if (result === undefined || result === null) {
        reply({ ok: false, error: `no handler for ${event}` })
        return
      }
      reply(result)
    } catch (err) {
      bridge.sendResult(frame.requestId, {
        ok: false,
        error: { code: 'rpc/tool-error', message: err instanceof Error ? err.message : String(err) },
      }, frame.generation)
    }
  }
  ws.configureConnection = (bridge) => {
    bridge.sendNotification('snapshot.respond', snapshot(bridge))
    bridge.setFrameHandler((frame) => {
      if (frame.op === 'snapshot.request') {
        const sinceId = (frame.payload as { sinceId?: number } | undefined)?.sinceId ?? 0
        bridge.sendNotification('snapshot.respond', snapshot(bridge, sinceId))
        return
      }
      if (frame.op === 'rpc.invoke') {
        void handleBrowserInvoke(bridge, frame)
      }
      if (frame.op === 'tool.invoke') {
        void handleToolInvoke(bridge, frame)
      }
      if (frame.op.startsWith('plugin-storage.')) {
        void handlePluginStorage(bridge, frame)
      }
    })
  }

  /**
   * Browser-side plugin-namespace storage RPC (v2 wire surface). Frames:
   *
   *   { pluginRunId, table, key, value? }  under op
   *   plugin-storage.get | .put | .delete | .keys
   *
   * Attribution: `pluginRunId` MUST resolve to a live lifecycle entry whose
   * namespace domain is open — the browser half may only touch its OWN
   * `plugin-<id>` domain, never another plugin's (an unknown run or an
   * undeclared table answers with an error frame, `plugin-ns-denied` /
   * `no-such-run`). Replies follow the rpc.result envelope ({ ok, data }).
   */
  async function handlePluginStorage(
    bridge: import('./ws/rpc-bridge.js').RpcBridge,
    frame: import('./ws/rpc-bridge.js').RpcFrame,
  ): Promise<void> {
    const payload = (frame.payload ?? {}) as {
      pluginRunId?: unknown
      table?: unknown
      key?: unknown
      value?: unknown
    }
    const action = frame.op.slice('plugin-storage.'.length) as 'get' | 'put' | 'delete' | 'keys'
    const runId = typeof payload.pluginRunId === 'string' ? payload.pluginRunId : ''
    const reply = (ok: boolean, data?: unknown, code?: string, message?: string): void => {
      bridge.sendResult(
        frame.requestId,
        ok
          ? { ok: true, data }
          : { ok: false, error: { code: code ?? 'plugin-ns-denied', message: message ?? 'plugin namespace access denied' } },
        frame.generation,
      )
    }
    if (!runId) {
      reply(false, undefined, 'no-such-run', 'pluginRunId is required')
      return
    }
    const entry = lifecycle.byRunId(runId)
    if (!entry?.storageDomain) {
      reply(false, undefined, 'no-such-run', `pluginRunId ${runId} has no open storage namespace`)
      return
    }
    const domain = entry.storageDomain as Domain<DomainSpec>
    const tableName = typeof payload.table === 'string' ? payload.table : ''
    if (!(PLUGIN_NS_TABLES as readonly string[]).includes(tableName)) {
      reply(false, undefined, 'plugin-ns-denied', `table '${tableName}' is not declared in namespace plugin-${entry.id}`)
      return
    }
    const table = domain.table(tableName)
    const key = typeof payload.key === 'string' ? payload.key : ''
    try {
      switch (action) {
        case 'get':
          if (!key) {
            reply(false, undefined, 'plugin-ns-denied', 'key is required')
            return
          }
          reply(true, table.get(key))
          return
        case 'put':
          if (!key) {
            reply(false, undefined, 'plugin-ns-denied', 'key is required')
            return
          }
          await table.put(key, payload.value)
          reply(true, undefined)
          return
        case 'delete':
          if (!key) {
            reply(false, undefined, 'plugin-ns-denied', 'key is required')
            return
          }
          reply(true, await table.delete(key))
          return
        case 'keys':
          reply(true, [...table.keys()])
          return
      }
    } catch (err) {
      reply(false, undefined, 'plugin-ns-denied', err instanceof Error ? err.message : String(err))
    }
  }

  const http = await startHttpServer({
    ringBuffer: buffer,
    auditDomain,
    client,
    loader,
    lifecycle,
    browserHalfPusher,
    installNpm: (spec: string) =>
      npmInstallPlugin({ spec, dataDir: opts.dataDir, ctx, lifecycle, pluginsDomain }),
    uninstallNpm: async (pluginRunId: string) => {
      const entry = lifecycle.byRunId(pluginRunId)
      if (entry) await uninstallNpmPlugin({ id: entry.id, dataDir: opts.dataDir, pluginsDomain })
    },
  }, { ...(opts.port !== undefined ? { port: opts.port } : {}), ...(opts.host !== undefined ? { host: opts.host } : {}) })
  http.server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? ''
    if (url === '/ws' || url.startsWith('/ws?')) {
      // `socket` is a net.Socket at runtime, but the HTTP 'upgrade'
      // callback types it as a Duplex. Cast to match ws's expected
      // `net.Socket` shape.
      ws.handleUpgrade(req, socket as never, head)
      return
    }
    socket.destroy()
  })

  // Wire the core services (auditClient, auditStore, plugins,
  // credentials, pluginStorage) + the three built-in plugins.
  installCoreServices(ctx, depsBag)
  ctx.registry.plugin(AuditPageHostPlugin)
  ctx.registry.plugin(ReplayPageHostPlugin)
  ctx.registry.plugin(PluginsPageHostPlugin)

  // Best-effort restart of previously-uploaded plugins.
  if (opts.restartFromDataDir !== false) {
    try {
      await loader.restartFromDataDir()
    } catch {
      // already logged
    }
    // install-by-name plugins: replay the npm registry ledger (best-effort).
    try {
      await restartNpmPlugins({ dataDir: opts.dataDir, ctx, lifecycle, pluginsDomain })
    } catch {
      // offline / broken spec — host still boots
    }
  }

  let stopped = false
  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    await lifecycle.stopAll() // disposes fibers, closes plugin-<id> domains
    await client.close()
    await ws.close()
    await http.close()
    // Storage teardown LAST: closeAll drains every still-open domain
    // (audit / plugins / credentials — plugin ns domains are already
    // closed by lifecycle.stopAll; double close is idempotent), then the
    // backend unregister + medium release follow the assembly's reverse
    // order.
    await facility.closeAll()
    unregisterJsonBackend()
    await jsonBackend.close()
    clearHostDeps()
  }

  return {
    ctx,
    http,
    ws,
    client,
    buffer,
    lifecycle,
    loader,
    port: http.port,
    dataDir: opts.dataDir,
    auditDomain,
    pluginsDomain,
    credentialsDomain,
    stop,
  }
}

export { PluginLoader, PluginLifecycle, HostAuditClient, AuditRingBuffer, WsHostServer }
export { npmInstallPlugin, restartNpmPlugins, uninstallNpmPlugin, InstallerError, PLUGINS_REGISTRY_DIR } from './plugins/installer.js'
export type { NpmInstallResult, NpmInstallPluginOptions, LedgerEntry } from './plugins/installer.js'
export type { AuditRecord } from './client/audit-record.js'
export { applyAuditQuery, parseAuditQuery } from './server/audit-route.js'
export type { AuditQuery } from './server/audit-route.js'