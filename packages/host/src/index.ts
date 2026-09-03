/**
 * @flowot/nx-pn-host — Node-side runtime. Spec §4.
 *
 * Public API:
 *   - startHost({ port, dataDir }) → boots HTTP + WS + cordis; returns
 *     a handle exposing the underlying server / client / port.
 *   - stopHost(handle) → graceful shutdown.
 */

import { CordisContext, type Context } from './cordis/cordis-shim.js'

import { startHttpServer, type StartedHttp } from './server/http-server.js'
import { WsHostServer } from './ws/ws-server.js'
import { BrowserHalfPusher } from './ws/browser-half-pusher.js'
import { AuditRingBuffer } from './client/ring-buffer.js'
import { HostAuditClient } from './client/audit-client.js'
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
  buffer: AuditRingBuffer<import('./client/audit-record.js').AuditRecord>
  lifecycle: PluginLifecycle
  loader: PluginLoader
  port: number
  dataDir: string
  stop(): Promise<void>
}

export async function startHost(opts: StartHostOptions): Promise<StartedHost> {
  const ctx = new CordisContext()
  const lifecycle = new PluginLifecycle()

  // The ring buffer's onPush broadcasts new records over WS. Construct the
  // ws server first (deferred `configureConnection` hook), then the buffer.
  const ws = new WsHostServer({ path: '/ws' })
  const browserHalfPusher = new BrowserHalfPusher({ ws })

  const broadcast = (op: import('./ws/rpc-bridge.js').RpcOp, payload: unknown): void => {
    ws.forEach((_s, bridge) => bridge.sendNotification(op, payload))
  }

  const buffer = new AuditRingBuffer<import('./client/audit-record.js').AuditRecord>({
    onPush: (record) => broadcast('audit.append', record),
  })
  const client = new HostAuditClient({ buffer })
  const loader = new PluginLoader({ dataDir: opts.dataDir, ctx, lifecycle })
  const depsBag: HostDeps = { ringBuffer: buffer, client, loader, lifecycle }

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
    })
  }

  const http = await startHttpServer({
    ringBuffer: buffer,
    client,
    loader,
    lifecycle,
    browserHalfPusher,
    installNpm: (spec: string) => npmInstallPlugin({ spec, dataDir: opts.dataDir, ctx, lifecycle }),
    uninstallNpm: async (pluginRunId: string) => {
      const entry = lifecycle.byRunId(pluginRunId)
      if (entry) await uninstallNpmPlugin({ id: entry.id, dataDir: opts.dataDir })
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

  // Wire the four core services + the three built-in plugins.
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
      await restartNpmPlugins({ dataDir: opts.dataDir, ctx, lifecycle })
    } catch {
      // offline / broken spec — host still boots
    }
  }

  let stopped = false
  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    await lifecycle.stopAll()
    await client.close()
    await ws.close()
    await http.close()
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
    stop,
  }
}

export { PluginLoader, PluginLifecycle, HostAuditClient, AuditRingBuffer, WsHostServer }
export { npmInstallPlugin, restartNpmPlugins, uninstallNpmPlugin, InstallerError, PLUGINS_REGISTRY_DIR } from './plugins/installer.js'
export type { NpmInstallResult, NpmInstallPluginOptions, LedgerEntry } from './plugins/installer.js'
export type { AuditRecord } from './client/audit-record.js'