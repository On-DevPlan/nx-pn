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

import { CordisContext, type Context } from './cordis/cordis-shim.js'
import { Pages, type PageRegistration } from './pages/pages-service.js'
import { WsTransport } from './rpc/connection.js'
import { RpcClient } from './rpc/rpc-client.js'
import type { RpcFrame } from './rpc/protocol.js'
import { parseSnapshot, type SnapshotData } from './snapshot/snapshot.js'
import {
  loadBrowserHalf,
  retractBrowserHalf,
  type BrowserHalfLoadMessage,
  type BrowserHalfRecord,
  type BrowserHalfRetractMessage,
} from './runner/browser-half-loader.js'

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
    // Reconcile browser halves against the manifest. The real loader
    // step is Plan 4 (see browser-half-loader); the seams are live.
    this.reconcile(snap)
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

  private reconcile(snap: SnapshotData): void {
    // TODO(plan4): manifest-vs-local diff → load/retract browser halves.
    void snap
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
  // Pages service: register on the root context (first instance wins).
  const pages = installPages(ctx)

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

function installPages(ctx: Context): Pages {
  let pages = ctx.pages as unknown as Pages | undefined
  if (!pages) {
    ctx.registry.plugin(Pages)
    pages = ctx.pages as unknown as Pages
  }
  return pages
}

function defaultWsUrl(): string {
  if (typeof location !== 'undefined') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/ws`
  }
  return 'ws://localhost:4560/ws'
}

export { Pages, type PageRegistration } from './pages/pages-service.js'
export { PageRegistry } from './pages/page-registry.js'
export { WsTransport, ReconnectController } from './rpc/connection.js'
export { RpcClient, RpcError } from './rpc/rpc-client.js'
export { MAX_FRAME_BYTES, RPC_DEFAULT_TIMEOUT_MS } from './rpc/protocol.js'
export { parseSnapshot } from './snapshot/snapshot.js'
export { loadBrowserHalf, retractBrowserHalf } from './runner/browser-half-loader.js'
export { ClientAuditClientProxy } from './audit/client-proxy.js'
export { CordisContext } from './cordis/cordis-shim.js'
export { fetchAudit, fetchReplay, fetchPluginList, stopPlugin, removePlugin, uninstallPlugin, uploadPlugin, installPluginByName, ApiError } from './host-api.js'
export type { PluginSummary, PluginInstallResult, AuditSnapshot, ReplayRequest, ApiErrorPayload } from './host-api.js'
export type { AuditRecord, AuditResponse } from './types.js'
export type { SnapshotData } from './snapshot/snapshot.js'
