/**
 * RPC client — request/response matching on top of the WS transport.
 * Mirrors host's RpcBridge semantics (§4.5.2):
 *
 *   - 30s default timeout (per-request override),
 *   - generation/socket-close reject-all-pending (`rpc/disconnected`),
 *   - stale-response rejection (generation or op mismatch),
 *   - oversized outbound frames → `payload/too-large` rejection,
 *   - NO auto-replay: after a disconnect, callers re-issue idempotent
 *     requests themselves.
 */

import {
  FRAME_TOO_LARGE_CODE,
  RPC_DEFAULT_TIMEOUT_MS,
  RPC_DISCONNECTED_CODE,
  type RpcFrame,
  type RpcOp,
} from './protocol.js'

export interface RpcClientOptions {
  /** Default timeout per request (ms). Default 30_000. */
  defaultTimeoutMs?: number
  /** Frame handler for push notifications (snapshot, audit.append, …). */
  onFrame?: (frame: RpcFrame) => void
}

export interface RequestOptions {
  /** Per-request timeout override (ms). */
  timeoutMs?: number
}

interface PendingEntry {
  op: RpcOp
  generation: number
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export class RpcError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'RpcError'
  }
}

export class RpcClient {
  private readonly pending = new Map<string, PendingEntry>()
  private nextId = 0
  private generation = 0
  private readonly defaultTimeoutMs: number
  private readonly onFrame: (frame: RpcFrame) => void
  private closed = false
  private readonly sendText: (text: string) => boolean

  constructor(sendText: (text: string) => boolean, opts: RpcClientOptions = {}) {
    this.sendText = sendText
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? RPC_DEFAULT_TIMEOUT_MS
    this.onFrame = opts.onFrame ?? (() => {})
  }

  /** New socket epoch: drop stale state, bump generation, notify listeners. */
  reset(generation: number): void {
    this.rejectAll(new RpcError(RPC_DISCONNECTED_CODE, 'connection reset'))
    this.generation = generation
    this.closed = false
  }

  /** Reject every pending request (socket close / generation change). */
  disconnectAll(reason?: RpcError): void {
    this.rejectAll(reason ?? new RpcError(RPC_DISCONNECTED_CODE))
  }

  private rejectAll(reason: RpcError): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      try {
        entry.reject(reason)
      } catch {
        // entries are independent
      }
    }
  }

  /** Permanent teardown. */
  close(): void {
    this.closed = true
    this.disconnectAll()
  }

  /**
   * One-way notification frame (no pending entry). Returns false if the
   * socket is not live or the frame is too large.
   */
  sendNotification(op: RpcOp, payload: unknown): boolean {
    if (this.closed) return false
    const frame: RpcFrame = {
      v: 1,
      generation: this.generation,
      requestId: `n:${this.nextId++}`,
      op,
      payload,
    }
    let text: string
    try {
      text = JSON.stringify(frame)
    } catch {
      return false
    }
    if (text.length > MAX_FRAME_BYTES_LOCAL()) return false
    return this.sendText(text)
  }

  /**
   * Round-trip request. Resolves with the server's `data` payload.
   * Rejects on timeout / mismatch / disconnect / oversized frame.
   */
  request(op: RpcOp, payload: unknown, opts: RequestOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new RpcError(RPC_DISCONNECTED_CODE))
    }
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs
    const requestId = `c:${this.nextId++}`
    const generation = this.generation
    const frame: RpcFrame = { v: 1, generation, requestId, op, payload }
    let text: string
    try {
      text = JSON.stringify(frame)
    } catch {
      return Promise.reject(new RpcError('payload/serialize', 'payload not serializable'))
    }
    if (text.length > MAX_FRAME_BYTES_LOCAL()) {
      return Promise.reject(new RpcError(FRAME_TOO_LARGE_CODE, 'frame exceeds MAX_FRAME_BYTES'))
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new RpcError('rpc/timeout', 'rpc timeout'))
      }, timeoutMs)
      this.pending.set(requestId, {
        op,
        generation,
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
        timer,
      })
      const ok = this.sendText(text)
      if (!ok) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(new RpcError(RPC_DISCONNECTED_CODE))
      }
    })
  }

  /**
   * Route one inbound frame (parsed already by the transport). Fulfills
   * matching pending requests; hands push notifications to the handler.
   */
  handleFrame(frame: RpcFrame): void {
    if (frame.op === 'rpc.result') {
      const entry = this.pending.get(frame.requestId)
      if (!entry) return // stray result — ignore
      if (entry.generation !== frame.generation) {
        this.pending.delete(frame.requestId)
        clearTimeout(entry.timer)
        entry.reject(new RpcError('rpc/protocol-mismatch', 'generation mismatch'))
        return
      }
      this.pending.delete(frame.requestId)
      clearTimeout(entry.timer)
      const payload = frame.payload as { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown } | undefined
      if (payload && payload.ok === false) {
        entry.reject(new RpcError(payload.error?.code ?? 'rpc/error', payload.error?.message))
        return
      }
      entry.resolve(payload?.data)
      return
    }
    // A non-result frame carrying a pending requestId is a protocol
    // violation — reject that entry.
    const entry = this.pending.get(frame.requestId)
    if (entry) {
      this.pending.delete(frame.requestId)
      clearTimeout(entry.timer)
      if (entry.generation !== frame.generation) {
        entry.reject(new RpcError('rpc/protocol-mismatch', 'generation mismatch'))
      } else {
        entry.reject(new RpcError('rpc/protocol-mismatch', `unexpected op ${frame.op} for pending request`))
      }
      return
    }
    this.onFrame(frame)
  }

  /** Pending request count (test introspection). */
  get pendingCount(): number {
    return this.pending.size
  }
}

function MAX_FRAME_BYTES_LOCAL(): number {
  // Injected lazily to keep the client bundlable in browsers (16 MiB).
  return 16 * 1024 * 1024
}
