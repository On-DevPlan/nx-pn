/**
 * WebSocketServer + heartbeat. Spec §4.5.3.
 *
 * Server side: every 30 seconds, ws.ping() all OPEN sockets. Each
 * socket tracks a `missed` counter, reset on 'pong'. Two consecutive
 * misses → terminate. interval.unref() so it doesn't block process exit.
 */

import type { IncomingMessage } from 'node:http'
import { WebSocketServer as WSServer, type WebSocket as WSWebSocket } from 'ws'

import { RpcBridge } from './rpc-bridge.js'

export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_MISS_LIMIT = 2

export interface WsServerOptions {
  path?: string
  heartbeatMs?: number
}

interface SocketState {
  ws: WSWebSocket
  bridge: RpcBridge
  missed: number
}

export class WsHostServer {
  private readonly wss: WSServer
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly states = new Map<WSWebSocket, SocketState>()

  /**
    * Deferred per-connection hook. The orchestrator sets this after the
    * WsHostServer is constructed (its dependencies — ring buffer,
    * lifecycle — are built later). Called with the socket's RpcBridge on
    * each accepted connection.
    */
  configureConnection: (bridge: RpcBridge) => void = () => {}

  constructor(opts: WsServerOptions = {}) {
    this.wss = new WSServer({ noServer: true, path: opts.path ?? '/ws' })
    this.heartbeat = setInterval(() => this.tick(), opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS)
    // §4.5.3 — unref so heartbeat doesn't keep the event loop alive
    this.heartbeat.unref()

    this.wss.on('connection', (ws) => {
      const state: SocketState = {
        ws,
        bridge: new RpcBridge({
          send: (text) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(text)
            }
          },
          close: (code, reason) => {
            try {
              ws.close(code, reason)
            } catch {
              // ignore
            }
          },
        }),
        missed: 0,
      }
      this.states.set(ws, state)

      ws.on('pong', () => {
        state.missed = 0
      })
      ws.on('close', () => {
        this.states.delete(ws)
        state.bridge.disconnectAll()
      })
      ws.on('error', () => {
        // swallow — 'close' will follow
      })
      ws.on('message', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf-8')
        state.bridge.handleInbound(text)
      })

      // Notify the orchestrator a socket is live (snapshot push, etc.).
      this.configureConnection(state.bridge)
    })
  }

  /** Per-connection upgrade handling for an existing HTTP server. */
  handleUpgrade(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req)
    })
  }

  /**
    * Iterate the currently-attached sockets, applying a callback to each
    * `(ws, bridge)` pair. Used by the orchestrator to push snapshots,
    * audit.append, plugin.changed, browser-half.* notifications.
    */
  forEach(cb: (ws: WSWebSocket, bridge: RpcBridge) => void): void {
    for (const [ws, state] of this.states) {
      if (ws.readyState === ws.OPEN) cb(ws, state.bridge)
    }
  }

  /** All currently-tracked WebSocket instances (test introspection). */
  get liveSocketCount(): number {
    return this.states.size
  }

  /** Heartbeat tick — ws.ping() every OPEN socket, terminate on 2 misses. */
  private tick(): void {
    for (const [ws, state] of this.states) {
      if (ws.readyState !== ws.OPEN) {
        this.states.delete(ws)
        continue
      }
      state.missed += 1
      if (state.missed >= HEARTBEAT_MISS_LIMIT) {
        try {
          ws.terminate()
        } catch {
          // ignore
        }
        this.states.delete(ws)
        state.bridge.disconnectAll()
        continue
      }
      try {
        ws.ping()
      } catch {
        // ignore — next tick will terminate
      }
    }
  }

  /** Close the WSS and stop heartbeats. */
  async close(): Promise<void> {
    clearInterval(this.heartbeat)
    for (const ws of this.states.keys()) {
      try {
        ws.terminate()
      } catch {
        // ignore
      }
    }
    this.states.clear()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
  }
}