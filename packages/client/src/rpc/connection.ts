/**
 * Browser-side WebSocket transport. Spec §4.5.2 / §4.5.3.
 *
 * Responsibilities:
 *   - drive the reconnect schedule from `navigator.onLine` + socket
 *     close/error events (the browser cannot send ws Ping frames, so the
 *     server drives the heartbeat; the client just reconnects),
 *   - wrap every message in the shared frame envelope and delegate to
 *     the owning RpcClient (or the registered frame handler) when the
 *     socket has not been reset,
 *   - stamp each socket with a fresh `generation` so stale responses
 *     from a dead socket can never satisfy a request on a newer socket.
 *
 * Deliberately protocol-agnostic about which ops mean what: the frame
 * handler belongs to the caller (RpcClient wires request matching,
 * snapshot reconciliation, browser-half loading, etc.).
 *
 * Testing: in Node the transport uses a shim (`ws` package); in the
 * browser it uses the native `WebSocket`. The class itself depends only
 * on the WHATWG `WebSocket`-compatible shape passed via `impl`.
 */

export interface ReconnectHandlers {
  /** Socket (re)opened with a fresh generation. */
  onOpen?: (generation: number) => void
  /** Socket closed (will attempt reconnect unless stopped). */
  onClose?: () => void
  /** Inbound text frame on a current-generation socket. */
  onMessage?: (text: string) => void
}

export interface WsTransportOptions {
  /** Full ws(s) URL, e.g. `ws://localhost:4560/ws`. */
  url: string
  /** Backoff bounds. Default 250ms…10s. */
  minDelayMs?: number
  maxDelayMs?: number
  handlers?: ReconnectHandlers
  /** WHATWG WebSocket ctor (injected for tests). */
  impl?: new (url: string, protocols?: string | string[]) => WebSocketLike
  /** Whether the network is currently considered online. Default true. */
  online?: boolean
}

/** Minimal structural shape of the WebSocket API this transport uses. */
export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'close', listener: (ev: { code?: number; reason?: string }) => void): void
  addEventListener(type: 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
  removeEventListener(type: string, listener: () => void): void
}

export const OPEN_STATE = 1

/**
 * Reconnect state machine.
 *
 *   idle → connecting → (open) → connected
 *     └────────── disconnect ──────────┘
 *     └───────── network off ──→ offline ── network on ──→ connecting
 *
 * Exposed for tests without a real browser.
 */
export class ReconnectController {
  /** 0 = offline, 1 = connected, 2 = connecting, 3 = stopped. */
  state: 'offline' | 'connected' | 'connecting' | 'stopped' = 'connecting'

  private online: () => boolean
  private readonly onlineEvent: () => void
  private readonly offlineEvent: () => void
  private readonly socketEvents: () => void
  private readonly opener: () => void
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(opts: {
    /** Current online status. */
    online: () => boolean
    /** Begin a socket attempt (caller owns the socket lifetime). */
    open: () => void
    /** Notify the controller a socket attempt opened. */
    onOpen: () => void
    /** Notify the controller a socket closed/errored. */
    onDown: () => void
    /** Schedule a reconnect after `ms`. */
    schedule: (ms: number) => void
    /** Called once the controller is permanently stopped. */
    onStopped?: (() => void) | undefined
    /** Online/offline listeners keyed for removal. */
    addOnlineListener: (fn: () => void) => void
    addOfflineListener: (fn: () => void) => void
    removeOnlineListener: (fn: () => void) => void
    removeOfflineListener: (fn: () => void) => void
  }) {
    this.online = opts.online
    this.opener = opts.open
    this.onlineEvent = () => this.retry(0)
    this.offlineEvent = () => this.goOffline()
    this.socketEvents = () => this.onDown()
    this.addOnline = opts.addOnlineListener
    this.addOffline = opts.addOfflineListener
    this.removeOnline = opts.removeOnlineListener
    this.removeOffline = opts.removeOfflineListener
    this.scheduleTimer = opts.schedule
    this.onOpened = opts.onOpen
    this.onDownNotify = opts.onDown
    this.onStopped = opts.onStopped
    this.addOnline(this.onlineEvent)
    this.addOffline(this.offlineEvent)
  }

  private addOnline: (fn: () => void) => void
  private addOffline: (fn: () => void) => void
  private removeOnline: (fn: () => void) => void
  private removeOffline: (fn: () => void) => void
  private scheduleTimer: (ms: number) => void
  private onOpened: () => void
  private onDownNotify: () => void
  private onStopped: (() => void) | undefined

  /** A socket attempt is starting. */
  private attemptStart(): void {
    if (this.state === 'stopped') return
    if (!this.online()) {
      this.state = 'offline'
      return
    }
    this.state = 'connecting'
    this.opener()
  }

  /** Socket attempt succeeded. */
  onSocketOpen(): void {
    if (this.state === 'stopped') return
    this.attempt = 0
    this.state = 'connected'
    this.onOpened()
  }

  /** Socket closed or errored. */
  private onDown(): void {
    if (this.state === 'stopped') return
    if (!this.online()) {
      this.goOffline()
      return
    }
    this.state = 'connecting'
    this.onDownNotify()
    this.retry(this.backoffMs())
  }

  private backoffMs(): number {
    return Math.min(1000 * 2 ** this.attempt, 10_000)
  }

  private retry(delay: number): void {
    if (this.state === 'stopped') return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.attempt += 1
    if (delay === 0) {
      this.attemptStart()
      return
    }
    this.scheduleTimer(delay)
  }

  private goOffline(): void {
    if (this.state === 'stopped') return
    this.state = 'offline'
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.onDownNotify()
  }

  /** Public: online event fired — reconnect immediately. */
  onlineNow(): void {
    if (this.state === 'stopped') return
    this.retry(0)
  }

  /** Public: an attempt is about to begin (transport calls this). */
  begin(): void {
    this.attemptStart()
  }

  /** Public: network/transport says down. */
  down(): void {
    this.onDown()
  }

  /** Public: transport says the socket opened. */
  open(): void {
    this.onSocketOpen()
  }

  /** Permanent teardown. */
  stop(): void {
    if (this.disposed) return
    this.disposed = true
    this.state = 'stopped'
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.removeOnline(this.onlineEvent)
    this.removeOffline(this.offlineEvent)
    this.onStopped?.()
  }
}

/**
 * Actual WebSocket transport used in the browser. Wraps a WHATWG
 * WebSocket, translates its events into the ReconnectController state
 * machine, and forwards text frames to the handlers.
 */
export class WsTransport {
  readonly controller: ReconnectController
  private readonly url: string
  private readonly minDelayMs: number
  private readonly maxDelayMs: number
  private readonly handlers: ReconnectHandlers
  private readonly Impl: new (url: string, protocols?: string | string[]) => WebSocketLike
  private socket: WebSocketLike | null = null
  private generation = 0
  private stopped = false
  private onFrameBound: ((ev: { data: unknown }) => void) | null = null

  constructor(opts: WsTransportOptions) {
    this.url = opts.url
    this.minDelayMs = opts.minDelayMs ?? 250
    this.maxDelayMs = opts.maxDelayMs ?? 10_000
    this.handlers = opts.handlers ?? {}
    // Default: native browser WebSocket. In Node tests the impl is
    // injected (the `ws` package's WebSocket).
    this.Impl = opts.impl ?? (globalThis as { WebSocket?: new (url: string, protocols?: string | string[]) => WebSocketLike }).WebSocket ?? (null as unknown as new (url: string, protocols?: string | string[]) => WebSocketLike)

    this.controller = new ReconnectController({
      online: () => opts.online ?? true,
      open: () => this.openSocket(),
      onOpen: () => this.handleOpen(),
      onDown: () => this.handleDown(),
      schedule: (ms) => this.scheduleReconnect(ms),
      addOnlineListener: (fn) => {
        if (typeof window !== 'undefined') window.addEventListener('online', fn)
      },
      addOfflineListener: (fn) => {
        if (typeof window !== 'undefined') window.addEventListener('offline', fn)
      },
      removeOnlineListener: (fn) => {
        if (typeof window !== 'undefined') window.removeEventListener('online', fn)
      },
      removeOfflineListener: (fn) => {
        if (typeof window !== 'undefined') window.removeEventListener('offline', fn)
      },
    })
  }

  /** Begin connecting (also reconnects after a down event). */
  connect(): void {
    this.controller.begin()
  }

  /** Last-known generation. */
  get currentGeneration(): number {
    return this.generation
  }

  /** Send a frame on the live socket (no-op when disconnected). */
  send(text: string): boolean {
    const s = this.socket
    if (!s || s.readyState !== OPEN_STATE) return false
    try {
      s.send(text)
      return true
    } catch {
      this.controller.down()
      return false
    }
  }

  /** Permanent teardown: close socket + stop reconnecting. */
  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.controller.stop()
    const s = this.socket
    this.socket = null
    if (s) {
      try {
        s.close(1000, 'client close')
      } catch {
        // ignore
      }
    }
  }

  private scheduleReconnect(ms: number): void {
    if (this.stopped) return
    setTimeout(() => {
      if (this.stopped) return
      this.controller.begin()
    }, ms)
  }

  private openSocket(): void {
    if (this.stopped) return
    try {
      const socket = new this.Impl(this.url)
      this.socket = socket
      socket.addEventListener('open', () => {
        if (this.socket !== socket) return
        this.generation = Date.now()
        this.controller.open()
      })
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return
        this.socket = null
        this.controller.down()
      })
      socket.addEventListener('error', () => {
        // 'close' follows; nothing to do here.
      })
      const onMessage = (ev: { data: unknown }): void => {
        if (this.socket !== socket) return
        if (typeof ev.data === 'string') {
          this.handlers.onMessage?.(ev.data)
        }
      }
      this.onFrameBound = onMessage
      socket.addEventListener('message', onMessage)
    } catch {
      this.socket = null
      this.controller.down()
    }
  }

  private handleOpen(): void {
    this.handlers.onOpen?.(this.generation)
  }

  private handleDown(): void {
    this.socket = null
    this.handlers.onClose?.()
  }
}
