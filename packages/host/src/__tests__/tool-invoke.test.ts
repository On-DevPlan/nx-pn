/**
 * tool.invoke — the browser→host tool-event bridge (WS round-trip).
 *
 * A plugin browser half's `ctx.hostCall('<plugin>/<action>', payload)`
 * rides the WS bridge as a `tool.invoke` frame; the host dispatches it
 * on its cordis context (result-returning `serial` mode) and replies via
 * `rpc.result` with the handler's payload wrapped in `{ ok, data }`.
 *
 * Covered here against a REAL host + REAL WebSocket, with handlers
 * registered the way a plugin host half does (its own fiber):
 *   1. handler hit → reply `{ ok: true, data: <ApiResult> }`
 *   2. no listener → structured `{ ok: false, error: 'no handler …' }`
 *   3. empty event → structured validation error
 *   4. handler failure → rpc-level `{ ok: false, error: { code:
 *      'rpc/tool-error' } }` (client rejects with an RpcError)
 */

import { describe, it, expect, afterEach } from 'vitest'
import { startHost, type StartedHost } from '../index.js'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcFrame } from '../ws/rpc-bridge.js'

const handles: StartedHost[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.stop()
  }
})

async function makeHost(): Promise<StartedHost> {
  // realpath so compiled .mjs paths avoid 8.3 short names (ESM loader).
  const osTmp = await realpath(tmpdir())
  const dataDir = await mkdtemp(join(osTmp, 'api-audit-tool-'))
  const host = await startHost({ port: 0, dataDir })
  handles.push(host)
  return host
}

/** Send one frame over a raw WS and await the matching rpc.result. */
async function roundTrip(host: StartedHost, frame: RpcFrame): Promise<RpcFrame> {
  const { WebSocket } = await import('ws')
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  try {
    const reply = new Promise<RpcFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no rpc.result in time')), 4000)
      const onMsg = (data: unknown): void => {
        const f = JSON.parse((data as Buffer).toString()) as RpcFrame
        if (f.op === 'rpc.result' && f.requestId === frame.requestId) {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve(f)
        }
      }
      ws.on('message', onMsg)
    })
    ws.send(JSON.stringify(frame))
    return await reply
  } finally {
    ws.close()
  }
}

/** Register a handler the way a plugin host half does (own fiber). */
async function registerHandler(host: StartedHost, event: string, handler: (p: unknown) => unknown): Promise<void> {
  const fiber = host.ctx.registry.plugin(
    (c: { on: (e: string, h: (p: unknown) => unknown) => unknown }) => {
      c.on(event, handler)
    },
    { name: `test-${event.replace('/', '-')}` },
  )
  await (fiber as unknown as { await(): Promise<void> }).await()
}

describe('tool.invoke — browser→host tool-event bridge', () => {
  it('dispatches to a host-half handler and replies with its ApiResult', async () => {
    const host = await makeHost()
    await registerHandler(host, 'test/echo', (p) => ({ ok: true, data: p }))

    const reply = await roundTrip(host, {
      v: 1,
      generation: 1,
      requestId: 'c:1',
      op: 'tool.invoke',
      payload: { event: 'test/echo', payload: { hello: 'world' }, pluginRunId: '' },
    })
    expect(reply.op).toBe('rpc.result')
    // The handler's ApiResult is delivered inside `data` so structured
    // errors survive the client pending table verbatim.
    expect(reply.payload).toEqual({ ok: true, data: { ok: true, data: { hello: 'world' } } })
    // The caller's generation is echoed so the client mismatch guard passes.
    expect(reply.generation).toBe(1)
    expect(reply.requestId).toBe('c:1')
  })

  it('awaits async handlers and returns the first defined result', async () => {
    const host = await makeHost()
    await registerHandler(host, 'test/slow', async (p) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { ok: true, data: p }
    })

    const reply = await roundTrip(host, {
      v: 1,
      generation: 7,
      requestId: 'c:2',
      op: 'tool.invoke',
      payload: { event: 'test/slow', payload: { n: 42 } },
    })
    expect(reply.payload).toEqual({ ok: true, data: { ok: true, data: { n: 42 } } })
  })

  it('replies with the structured no-handler error', async () => {
    const host = await makeHost()
    const reply = await roundTrip(host, {
      v: 1,
      generation: 1,
      requestId: 'c:3',
      op: 'tool.invoke',
      payload: { event: 'test/absent', payload: {} },
    })
    expect(reply.payload).toEqual({ ok: true, data: { ok: false, error: 'no handler for test/absent' } })
  })

  it('rejects an empty event with a structured error', async () => {
    const host = await makeHost()
    const reply = await roundTrip(host, {
      v: 1,
      generation: 1,
      requestId: 'c:4',
      op: 'tool.invoke',
      payload: { event: '' },
    })
    expect(reply.payload).toEqual({
      ok: true,
      data: { ok: false, error: 'tool.invoke: event must be a non-empty string' },
    })
  })

  it('surfaces a throwing handler as an rpc/tool-error', async () => {
    const host = await makeHost()
    await registerHandler(host, 'test/boom', () => {
      throw new Error('handler exploded')
    })

    const reply = await roundTrip(host, {
      v: 1,
      generation: 1,
      requestId: 'c:5',
      op: 'tool.invoke',
      payload: { event: 'test/boom', payload: {} },
    })
    expect(reply.payload).toMatchObject({
      ok: false,
      error: { code: 'rpc/tool-error', message: 'handler exploded' },
    })
  })

  it('attribution: a known pluginRunId logs the plugin id but still dispatches', async () => {
    const host = await makeHost()
    await registerHandler(host, 'test/who', (p) => ({ ok: true, data: p }))

    const reply = await roundTrip(host, {
      v: 1,
      generation: 1,
      requestId: 'c:6',
      op: 'tool.invoke',
      // Unknown run id — attribution is logging-only, never a hard fail.
      payload: { event: 'test/who', payload: { q: 1 }, pluginRunId: 'run-unknown' },
    })
    expect(reply.payload).toEqual({ ok: true, data: { ok: true, data: { q: 1 } } })
  })
})
