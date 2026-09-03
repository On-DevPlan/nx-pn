/**
 * RPC frame protocol. Spec §4.5.1 / §4.5.2.
 *
 * Hard constraints:
 *   - MAX_FRAME_BYTES = 16 MB; inbound close(1008) / outbound reject.
 *   - Default timeout: 30 seconds.
 *   - Generation + op mismatch → reject, never deliver.
 *   - On socket close or generation change → reject all pending.
 */

export const MAX_FRAME_BYTES = 16 * 1024 * 1024

export interface RpcFrame {
  v: 1
  generation: number
  requestId: string
  op: RpcOp
  payload: unknown
}

export type RpcOp =
  | 'snapshot.request'
  | 'snapshot.respond'
  | 'audit.append'
  | 'plugin.changed'
  | 'rpc.invoke'
  | 'rpc.result'
  | 'browser-half.load'
  | 'browser-half.retract'
  | 'error'

export const RPC_DEFAULT_TIMEOUT_MS = 30_000
export const FRAME_TOO_LARGE_CODE = 'payload/too-large'
export const RPC_DISCONNECTED_CODE = 'rpc/disconnected'

export class RpcError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code)
  }
}

const encoder = new TextEncoder()

/** Inbound size check (per spec §4.5.2). */
export function isInboundFrameTooLarge(data: string): boolean {
  return encoder.encode(data).byteLength > MAX_FRAME_BYTES
}

/** Outbound size check — caller must NOT serialize if true. */
export function wouldFrameExceedLimit(payload: unknown): boolean {
  try {
    return JSON.stringify(payload).length > MAX_FRAME_BYTES
  } catch {
    // circular / bigint etc. — treat as too large
    return true
  }
}

export interface PendingEntry {
  op: RpcOp
  generation: number
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
  /** Caller-side timeout (ms). */
  timeoutMs: number
}

/**
 * Encode + size-check a frame; returns the JSON string or throws an
 * RpcError(FRAME_TOO_LARGE_CODE) so callers can synthesise an error
 * response instead of pushing oversize bytes onto the socket.
 */
export function encodeFrame(frame: RpcFrame): string {
  const json = JSON.stringify(frame)
  if (json.length > MAX_FRAME_BYTES) {
    throw new RpcError(FRAME_TOO_LARGE_CODE, 'frame exceeds MAX_FRAME_BYTES')
  }
  return json
}

/** Decode + validate a frame's shape (not its semantic op/generation). */
export function decodeFrame(text: string): RpcFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new RpcError('protocol/parse-error', (err as Error).message)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new RpcError('protocol/parse-error', 'not an object')
  }
  const f = parsed as Partial<RpcFrame>
  if (f.v !== 1) throw new RpcError('protocol/version-mismatch', 'v !== 1')
  if (typeof f.generation !== 'number') throw new RpcError('protocol/parse-error', 'generation missing')
  if (typeof f.requestId !== 'string') throw new RpcError('protocol/parse-error', 'requestId missing')
  if (typeof f.op !== 'string') throw new RpcError('protocol/parse-error', 'op missing')
  return {
    v: 1,
    generation: f.generation,
    requestId: f.requestId,
    op: f.op as RpcOp,
    payload: f.payload,
  }
}
// ---------------------------------------------------------------------------
// RpcBridge — pending table + send helper for a single websocket. Spec
// §4.5.1 / §4.5.2.
//
// Owns:
//   - the monotonic pending table
//   - the per-socket "generation" (incremented on disconnect/reset)
//   - sending (with outbound frame-size check)
//   - rejecting all pending when the socket dies
//
// Does NOT own:
//   - the actual WebSocket connection (caller passes a `send` function
//     and a `close` function so this class can be tested with mocks).

export interface RpcBridgeOptions {
  /** Send a frame to the underlying socket. Must not throw on closed sockets. */
  send: (text: string) => void
  /** Close the socket (for example on protocol errors). */
  close: (code: number, reason: string) => void
  /** Initial generation (typically Date.now()). */
  initialGeneration?: number
  /** Override default timeout (ms). */
  defaultTimeoutMs?: number
  /**
    * Called with each inbound non-`rpc.result` frame (push notifications,
    * server invocations, snapshot requests). Spec §4.5.1.
    */
  onFrame?: (frame: RpcFrame) => void
}

export interface RpcInvokeOptions {
  timeoutMs?: number
  payload?: unknown
}

export class RpcBridge {
  readonly generation: number
  private readonly pending = new Map<string, PendingEntry>()
  private nextRequestId = 0
  private readonly send: (text: string) => void
  private readonly closeSocket: (code: number, reason: string) => void
  private readonly defaultTimeoutMs: number
  private onFrame: (frame: RpcFrame) => void
  private closed = false

  constructor(opts: RpcBridgeOptions) {
    this.generation = opts.initialGeneration ?? Date.now()
    this.send = opts.send
    this.closeSocket = opts.close
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? RPC_DEFAULT_TIMEOUT_MS
    this.onFrame = opts.onFrame ?? (() => {})
  }

  /**
    * Send a one-way notification (no pending tracking). Outbound frame-size
    * enforced. Returns false on too-large; never throws.
    */
  sendNotification(op: RpcOp, payload: unknown): boolean {
    if (this.closed) return false
    const requestId = `n:${this.nextRequestId++}`
    const frame: RpcFrame = {
      v: 1,
      generation: this.generation,
      requestId,
      op,
      payload,
    }
    try {
      const text = encodeFrame(frame)
      this.send(text)
      return true
    } catch (err) {
      if (err instanceof RpcError && err.code === FRAME_TOO_LARGE_CODE) {
        this.send(JSON.stringify({
          v: 1,
          generation: this.generation,
          requestId,
          op: 'error',
          payload: { ok: false, error: { code: FRAME_TOO_LARGE_CODE } },
        }))
        return false
      }
      throw err
    }
  }

  /**
    * Invoke a round-trip op. Returns the matching response payload (the
    * contents of `result.payload`). Rejects on:
    *   - timeout (after `timeoutMs` ms; default 30s)
    *   - generation mismatch (`rpc/protocol-mismatch`)
    *   - socket disconnect (`rpc/disconnected`)
    *   - outbound frame-too-large
    */
  invoke(op: RpcOp, payload: unknown, opts: RpcInvokeOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new RpcError(RPC_DISCONNECTED_CODE))
    }
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs
    const requestId = `c:${this.nextRequestId++}`
    const frame: RpcFrame = {
      v: 1,
      generation: this.generation,
      requestId,
      op,
      payload,
    }
    let text: string
    try {
      text = encodeFrame(frame)
    } catch (err) {
      return Promise.reject(err)
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new RpcError('rpc/timeout', 'rpc timeout'))
      }, timeoutMs)
      this.pending.set(requestId, {
        op,
        generation: this.generation,
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
        timer,
        timeoutMs,
      })
      try {
        this.send(text)
      } catch (err) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  /**
    * Handle one inbound text frame. Routes:
    *   - `rpc.result` → fulfill the matching pending entry (generation
    *     mismatch rejects)
    *   - any other op with a pending requestId → protocol-mismatch reject
    *   - otherwise → handed to the registered handler (if any)
    */
  handleInbound(text: string, handler?: (frame: RpcFrame) => void): void {
    if (isInboundFrameTooLarge(text)) {
      this.closeSocket(1008, 'frame too large')
      this.disconnectAll(new RpcError(RPC_DISCONNECTED_CODE, 'frame too large'))
      return
    }
    let frame: RpcFrame
    try {
      frame = decodeFrame(text)
    } catch (err) {
      // Bad JSON / version mismatch → drop the socket.
      this.closeSocket(1008, (err as Error).message)
      this.disconnectAll(new RpcError(RPC_DISCONNECTED_CODE, (err as Error).message))
      return
    }

    if (frame.op === 'rpc.result') {
      const entry = this.pending.get(frame.requestId)
      if (!entry) return // ignore stray result
      if (entry.generation !== frame.generation) {
        this.pending.delete(frame.requestId)
        entry.reject(new RpcError('rpc/protocol-mismatch', 'generation mismatch'))
        return
      }
      this.pending.delete(frame.requestId)
      const payload = frame.payload as { ok?: boolean; error?: { code: string; message?: string }; data?: unknown }
      if (payload && payload.ok === false) {
        entry.reject(new RpcError(payload.error?.code ?? 'rpc/error', payload.error?.message))
        return
      }
      entry.resolve(payload?.data)
      return
    } else {
      // A non-`rpc.result` frame carrying a pending requestId is a
      // protocol violation → reject that entry.
      const entry = this.pending.get(frame.requestId)
      if (entry) {
        if (entry.generation !== frame.generation) {
          this.pending.delete(frame.requestId)
          entry.reject(new RpcError('rpc/protocol-mismatch', 'generation mismatch'))
          return
        }
        this.pending.delete(frame.requestId)
        entry.reject(new RpcError('rpc/protocol-mismatch', `unexpected op ${frame.op} for pending request`))
        return
      }
    }

    // Otherwise hand to the registered frame handler (push notifications,
    // server invocations, snapshot requests, etc.).
    this.onFrame(frame)
    // Back-compat with the old per-call handler argument (tests use it).
    handler?.(frame)
  }

  /**
    * Called when the underlying socket closes. Rejects every pending entry
    * with `rpc/disconnected`. No auto-replay.
    */
  disconnectAll(reason?: RpcError): void {
    this.closed = true
    const err = reason ?? new RpcError(RPC_DISCONNECTED_CODE)
    for (const [, entry] of this.pending) {
      try {
        entry.reject(err)
      } catch {
        // ignore — pending entries are independent
      }
    }
    this.pending.clear()
  }

  /** Pending entry count (test introspection). */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
    * Override/clear the inbound-frame handler at runtime. The
    * orchestrator sets this after construction to route frames such as
    * `snapshot.request`.
    */
  setFrameHandler(handler: ((frame: RpcFrame) => void) | null): void {
    this.onFrame = handler ?? (() => {})
  }
}
