/**
 * WsHostServer tests — real WebSocket connections, short heartbeat.
 * Spec §4.5.3: server pings every 30s, resets on pong, terminates a
 * socket after 2 missed pings.
 */

import { describe, it, expect } from 'vitest'
import { WsHostServer } from '../ws/ws-server.js'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type Server } from 'node:http'

async function boot(opts: { heartbeatMs: number; path?: string }): Promise<{ http: Server; ws: WsHostServer; port: number }> {
  const http = createServer()
  const ws = new WsHostServer({ path: opts.path ?? '/ws', heartbeatMs: opts.heartbeatMs })
  http.on('upgrade', (req, socket, head) => {
    ws.handleUpgrade(req, socket as never, head)
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  return { http, ws, port }
}

describe('WsHostServer', () => {
  it('accepts a client connection', async () => {
    const { http, ws, port } = await boot({ heartbeatMs: 200 })
    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve, reject) => {
        client.on('open', () => resolve())
        client.on('error', reject)
      })
      expect(ws.liveSocketCount).toBe(1)
      client.close()
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      ws.close()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  })

  it('sends ws ping frames and terminates sockets that never pong', async () => {
    const { http, ws, port } = await boot({ heartbeatMs: 40 })
    try {
      // A real client auto-responds to pings (ws library does), so to
      // simulate a dead peer we monkey-patch respond. Actually the `ws`
      // client library auto-replies to pings by default. To test the
      // 2-miss terminate we need a socket that does NOT pong. We can use
      // the low-level socket by stopping the auto-pong.
      const { createConnection } = await import('node:net')
      const raw = createConnection({ host: '127.0.0.1', port })
      await new Promise<void>((resolve) => raw.once('connect', resolve))
      // Perform the WS handshake manually.
      const key = Buffer.from('012345678901234567890123').toString('base64')
      raw.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
      // Read the handshake response (crudely), then verify the server
      // closes the socket after ~2 heartbeat intervals.
      await new Promise<void>((resolve) => {
        raw.once('data', () => resolve())
      })
      // Do NOT pong — wait for the server to terminate (missed>=2).
      await new Promise<void>((resolve) => {
        raw.once('close', () => resolve())
        raw.once('error', () => resolve())
        // Timeout guard.
        setTimeout(() => resolve(), 2000)
      })
      // Give the ws-server a moment to prune.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(ws.liveSocketCount).toBe(0)
    } finally {
      ws.close()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  })
})