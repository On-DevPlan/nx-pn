/**
 * BrowserRuntime — the browser-side cordis + WS RPC orchestration.
 * Spec §5.6.
 *
 *   connectRpc(ctx, opts)
 *     → create browser Context if none supplied
 *     → wire Pages service
 *     → open the WS transport, register frames
 *     → snapshot.respond → onSnapshot (audit + plugin manifest)
 *     → browser-half.load / browser-half.retract → BrowserRuntime
 *     → returns a BrowserRuntime handle
 */

import { CordisContext, type Context, type Fiber } from './cordis/cordis-shim.js'
import { Pages, type PageRegistration } from './pages/pages-service.js'
import { WsTransport } from './rpc/connection.js'
import { RpcClient } from './rpc/rpc-client.js'
import type { RpcFrame } from './rpc/protocol.js'
import { parseSnapshot, type SnapshotData } from './snapshot/snapshot.js'
import { AuditClientService, bindAuditRpc } from './audit/audit-client-service.js'
import { ClientAuditClientProxy } from './audit/client-proxy.js'
import {
  loadBrowserHalf,
  retractBrowserHalf,
  type BrowserHalfLoadMessage,
  type BrowserHalfRecord,
  type BrowserHalfRetractMessage,
} from './runner/browser-half-loader.js'
import { loadBrowserHalfSource } from './runner/plugin-sync.js'

export interface ConnectRpcOptions {
  /** ws URL. Default `ws://<location.host>/ws`. */
  url?: string
  /** Existing browser Context (tests). Otherwise a fresh one is created. */
  ctx?: Context
  /** Reconnect backoff bounds (default 250ms…10s). */
  minDelayMs?: number
  maxDelayMs?: number
  /** Optional injected WebSocket ctor (tests). */
  wsImpl?: new (url: string, protocols?: string | string[]) => unknown
}

export interface BrowserRuntimeHandle {
  ctx: Context
  pages: Pages
  /** Snapshot listeners (React stores subscribe here). */
  onSnapshot: (cb: (snap: SnapshotData) => void) => () => void
  /** Latest snapshot (or undefined pre-connect). */
  snapshot: () => SnapshotData | undefined
  /** Current connection state. */
  status: () => 'offline' | 'connected' | 'connecting' | 'stopped'
  /** Close the WS + stop reconnecting. */
  close(): void
}

export interface BrowserRuntimeDeps {
  ctx: Context
  transport: WsTransport
  rpc: RpcClient
  onSnapshot?: (snap: SnapshotData) => void
  onAuditPush?: (record: unknown) => void
  onPluginChanged?: () => void
}

/** Frame payload shapes from the host (§4.5.1). */
interface SnapshotRespondPayload {
  generation?: number
  auditLastId?: number
  records?: unknown[]
  plugins?: unknown[]
}

/** State that survives disconnects (audit records + loaded browser halves). */
export class BrowserRuntime {
  private readonly ctx: Context
  private readonly rpc: RpcClient
  private readonly transport: WsTransport
  private snapshotListeners = new Set<(snap: SnapshotData) => void>()
  private currentSnapshot: SnapshotData | undefined
  private readonly auditPushes: ((record: unknown) => void)[]
  private readonly halves = new Map<string, BrowserHalfRecord>()
  /** pluginRunIds with an in-flight reconcile load (dedupes races). */
  private readonly loading = new Set<string>()

  constructor(deps: BrowserRuntimeDeps) {
    this.ctx = deps.ctx
    this.rpc = deps.rpc
    this.transport = deps.transport
    this.auditPushes = deps.onAuditPush ? [deps.onAuditPush] : []
  }

  /** @internal the RpcClient (frame routing). */
  get rpcClient(): RpcClient {
    return this.rpc
  }

  get status(): 'offline' | 'connected' | 'connecting' | 'stopped' {
    return this.transport.controller.state
  }

  snapshot(): SnapshotData | undefined {
    return this.currentSnapshot
  }

  onSnapshot(cb: (snap: SnapshotData) => void): () => void {
    this.snapshotListeners.add(cb)
    if (this.currentSnapshot) cb(this.currentSnapshot)
    return () => {
      this.snapshotListeners.delete(cb)
    }
  }

  onAuditPush(cb: (record: unknown) => void): () => void {
    this.auditPushes.push(cb)
    return () => {
      const i = this.auditPushes.indexOf(cb)
      if (i >= 0) this.auditPushes.splice(i, 1)
    }
  }

  /** Handle a parsed snapshot (server push or response to request). */
  applySnapshot(payload: unknown): void {
    const snap = parseSnapshot(payload)
    if (!snap) return
    this.currentSnapshot = snap
    // Reconcile browser halves against the manifest: on a fresh connect
    // (cold start / reload) fetch each declared browser half's compiled
    // source over REST and load it; retract halves whose plugin vanished.
    void this.reconcile(snap)
    for (const cb of [...this.snapshotListeners]) {
      try {
        cb(snap)
      } catch {
        // listener errors are isolated
      }
    }
  }

  /** Deliver an audit.append push. */
  applyAuditPush(record: unknown): void {
    for (const cb of [...this.auditPushes]) {
      try {
        cb(record)
      } catch {
        // isolated
      }
    }
  }

  /** Load + register a browser half (host pushed code). */
  async applyBrowserHalfLoad(msg: BrowserHalfLoadMessage): Promise<void> {
    const record = await loadBrowserHalf({ ctx: this.ctx }, msg)
    this.halves.set(msg.pluginRunId, record)
  }

  /** Retract (stop) a browser half. */
  async applyBrowserHalfRetract(msg: BrowserHalfRetractMessage): Promise<void> {
    const record = this.halves.get(msg.pluginRunId)
    if (!record) return
    this.halves.delete(msg.pluginRunId)
    await retractBrowserHalf({ ctx: this.ctx }, record)
  }

  /**
   * Manifest-vs-local diff → load missing browser halves (REST feed),
   * retract stale ones. Best-effort: a fetch/load failure never breaks
   * the snapshot pipeline (the WS push path covers hot adds).
   */
  private async reconcile(snap: SnapshotData): Promise<void> {
    const wanted = new Map<string, { id: string; pluginRunId: string }>()
    for (const p of snap.plugins) {
      if (p.manifest.halves.browser?.entry) {
        wanted.set(p.pluginRunId, { id: p.id, pluginRunId: p.pluginRunId })
      }
    }
    for (const meta of wanted.values()) {
      if (this.halves.has(meta.pluginRunId) || this.loading.has(meta.pluginRunId)) continue
      this.loading.add(meta.pluginRunId)
      try {
        const record = await loadBrowserHalfSource(this.ctx, meta)
        if (record) this.halves.set(meta.pluginRunId, record)
      } catch {
        // isolate — a bad half must not kill the snapshot pipeline
      } finally {
        this.loading.delete(meta.pluginRunId)
      }
    }
    for (const [runId, record] of [...this.halves]) {
      if (!wanted.has(runId)) {
        this.halves.delete(runId)
        try {
          await retractBrowserHalf({ ctx: this.ctx }, record)
        } catch {
          // isolate
        }
      }
    }
  }

  close(): void {
    this.transport.close()
  }
}

/**
 * Establish the WS RPC bridge + wire a browser Context.
 *
 * Returns the runtime handle; `status()` reports the connection state
 * (the UI can render "连接中…" until `connected`).
 */
export async function connectRpc(opts: ConnectRpcOptions = {}): Promise<BrowserRuntimeHandle> {
  const ctx = opts.ctx ?? (new CordisContext() as Context)
  // Pages service: register on the root context AND await the fiber so
  // `ctx.pages` resolves to the live service instance before any caller
  // (the web shell or a loaded browser half) reads it. Without the
  // await the cordis service proxy is still empty and `runtime.pages`
  // is undefined — exactly the singleton-wiring bug that made plugin
  // pages invisible to the shell (the loader's `ctx.pages.register`
  // resolves to a *different* instance than the one `connectRpc`
  // returned). First instance wins per the comment in pages-service.ts.
  const pages = await installPages(ctx)

  const url = opts.url ?? defaultWsUrl()
  const transport = new WsTransport({
    url,
    ...(opts.minDelayMs !== undefined ? { minDelayMs: opts.minDelayMs } : {}),
    ...(opts.maxDelayMs !== undefined ? { maxDelayMs: opts.maxDelayMs } : {}),
    ...(opts.wsImpl !== undefined ? { impl: opts.wsImpl as never } : {}),
    handlers: {
      onOpen: () => {
        // New epoch — reset the RPC client, then ask for a fresh snapshot.
        rpc.reset(transport.currentGeneration)
        rpc.sendNotification('snapshot.request', { sinceId: runtime.snapshot()?.auditLastId ?? 0 })
      },
      onMessage: (text) => {
        try {
          const frame = JSON.parse(text) as RpcFrame
          rpc.handleFrame(frame)
        } catch {
          // malformed inbound frame — ignore (host closes on protocol errors)
        }
      },
      onClose: () => {
        rpc.disconnectAll()
      },
    },
  })

  const rpc = new RpcClient((text: string) => transport.send(text), {
    onFrame: (frame) => routeFrame(runtime, frame),
  })
  // AuditClient service: the browser-half loader declares
  // `inject: ['pages', 'auditClient']` so cordis activates a plugin
  // fiber only when both services are present. AuditClientService reads
  // the calling half's pluginRunId off its fiber config and rides the
  // WS bridge as an `rpc.invoke` frame (§5.5).
  installAuditClient(ctx)
  bindAuditRpc(rpc)
  const runtime = new BrowserRuntime({ ctx, transport, rpc })

  transport.connect()

  return {
    ctx,
    pages,
    onSnapshot: (cb) => runtime.onSnapshot(cb),
    snapshot: () => runtime.snapshot(),
    status: () => runtime.status,
    close: () => runtime.close(),
  }
}

/** Route inbound push frames (§4.5.1). */
function routeFrame(runtime: BrowserRuntime, frame: RpcFrame): void {
  switch (frame.op) {
    case 'snapshot.respond':
      runtime.applySnapshot(frame.payload)
      break
    case 'audit.append':
      runtime.applyAuditPush(frame.payload)
      break
    case 'plugin.changed':
      // Manifest changed — ask for a fresh snapshot to reconcile.
      runtime.rpcClient.sendNotification('snapshot.request', { sinceId: runtime.snapshot()?.auditLastId ?? 0 })
      break
    case 'browser-half.load':
      void runtime.applyBrowserHalfLoad(frame.payload as BrowserHalfLoadMessage)
      break
    case 'browser-half.retract':
      void runtime.applyBrowserHalfRetract(frame.payload as BrowserHalfRetractMessage)
      break
    case 'error':
      // Host signalled a protocol error on our outbound path.
      break
    default:
      break
  }
}

async function installPages(ctx: Context): Promise<Pages> {
  let pages = ctx.pages as unknown as Pages | undefined
  if (!pages) {
    const fiber = ctx.registry.plugin(Pages) as unknown as Fiber
    // The fiber's `await` resolves once the Pages service is fully
    // active and `ctx.pages` resolves to the live service proxy.
    // Skipping this await leaves `ctx.pages` undefined and the shell
    // sees an empty pages snapshot even after a successful install.
    await fiber.await()
    pages = ctx.pages as unknown as Pages
  }
  return pages
}

/**
 * Register the auditClient cordis service so the loader's
 * `inject: ['pages', 'auditClient']` is satisfied when any browser half
 * (e.g. plugins/echo's onSend → auditClient.get) accesses it via
 * ctx.auditClient. The service resolves each call's pluginRunId from the
 * calling half's fiber config, so every rpc.invoke carries the right run
 * id and the host attributes the audit row to the correct plugin.
 *
 * Constructing AuditClientService provides it on the root context (the
 * cordis Service constructor calls reflect.provide); unlike Pages we
 * don't need to await a fiber because the service has no async init.
 */
function installAuditClient(ctx: Context): void {
  const already = (ctx.reflect as { _getImpl?: (n: string, strict?: boolean) => unknown })._getImpl?.('auditClient', true)
  if (already) return
  void new AuditClientService(ctx)
}

function defaultWsUrl(): string {
  if (typeof location !== 'undefined') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/ws`
  }
  return 'ws://localhost:4560/ws'
}

export { Pages, type PageRegistration } from './pages/pages-service.js'
export type { PageRouteEntry } from './pages/page-registry.js'
export { PageRegistry } from './pages/page-registry.js'
export { WsTransport, ReconnectController } from './rpc/connection.js'
export { RpcClient, RpcError } from './rpc/rpc-client.js'
export { MAX_FRAME_BYTES, RPC_DEFAULT_TIMEOUT_MS } from './rpc/protocol.js'
export { parseSnapshot } from './snapshot/snapshot.js'
export { loadBrowserHalf, retractBrowserHalf, SHARED_BROWSER_EXTERNALS } from './runner/browser-half-loader.js'
export {
  fetchBrowserHalfSource,
  loadBrowserHalfSource,
  installBrowserHalfFromHost,
  type InstallBrowserHalfFromHostOptions,
} from './runner/plugin-sync.js'
export { ClientAuditClientProxy } from './audit/client-proxy.js'
export { CordisContext } from './cordis/cordis-shim.js'
export { fetchAudit, fetchReplay, fetchPluginList, stopPlugin, removePlugin, uninstallPlugin, uploadPlugin, installPluginByName, ApiError } from './host-api.js'
export type { PluginSummary, PluginInstallResult, AuditSnapshot, ReplayRequest, ApiErrorPayload } from './host-api.js'
export type { AuditRecord, AuditResponse } from './types.js'
export type { SnapshotData } from './snapshot/snapshot.js'
