import { describe, it, expect, vi } from 'vitest'
import { RpcClient } from '../rpc/rpc-client.js'
import { WsTransport, ReconnectController } from '../rpc/connection.js'
import { BrowserRuntime } from '../index.js'
import { CordisContext } from '../cordis/cordis-shim.js'

describe('RpcClient + transport frame round-trip', () => {
  it('request/response over a raw socket shim', async () => {
    const serverText: Array<{ requestId: string; op: string; payload: unknown }> = []
    const client = new RpcClient((text) => {
      serverText.push(JSON.parse(text))
      return true
    })
    client.reset(7)
    const p = client.request('snapshot.request', { sinceId: 3 })
    client.handleFrame({
      v: 1,
      generation: 7,
      requestId: serverText[0]!.requestId,
      op: 'rpc.result',
      payload: { ok: true, data: { auditLastId: 3 } },
    })
    await expect(p).resolves.toEqual({ auditLastId: 3 })
  })
})

/** Minimal WebSocket shim so the transport can be constructed in Node. */
class FakeWebSocket {
  readyState = 0
  private openListeners: Array<() => void> = []
  private closed = false

  constructor(public url: string) {
    setTimeout(() => {
      if (this.closed) return
      this.readyState = 1
      for (const l of this.openListeners) l()
    }, 5)
  }

  send(): void { /* noop — server-less harness */ }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
  }

  addEventListener(type: string, fn: never): void {
    if (type === 'open') this.openListeners.push(fn as () => void)
  }

  removeEventListener(): void { /* noop */ }
}

describe('BrowserRuntime + snapshot + audit push', () => {
  it('applies a snapshot and notifies subscribers', async () => {
    const ctx = new CordisContext() as never
    const transport = new WsTransport({
      url: 'ws://fake/ws',
      impl: FakeWebSocket as never,
    })
    const received: unknown[] = []
    const runtime = new BrowserRuntime({
      ctx,
      transport,
      rpc: new RpcClient(() => transport.send(''), {}),
    })
    const sub = runtime.onSnapshot((s) => received.push(s))
    // The runtime's applySnapshot mirrors what routeFrame does on a
    // snapshot.respond frame.
    runtime.applySnapshot({
      generation: 1,
      auditLastId: 10,
      records: [{ id: 1 }],
      plugins: [{ id: 'demo', pluginRunId: 'run-1', manifest: { schemaVersion: 1, id: 'demo', version: '1.0.0', title: 'Demo', halves: {} } }],
    })
    expect(runtime.snapshot()?.auditLastId).toBe(10)
    expect(received).toHaveLength(1)
    sub()
    transport.close()
  })

  it('audit.append pushes reach subscribers', () => {
    const ctx = new CordisContext() as never
    const transport = new WsTransport({
      url: 'ws://fake/ws',
      impl: FakeWebSocket as never,
    })
    const runtime = new BrowserRuntime({
      ctx,
      transport,
      rpc: new RpcClient(() => true, {}),
    })
    const seen: unknown[] = []
    runtime.onAuditPush((r) => seen.push(r))
    runtime.applyAuditPush({ id: 1, initiator: 'core', method: 'GET', url: '/x' })
    expect(seen).toHaveLength(1)
    expect((seen[0] as { id: number }).id).toBe(1)
    transport.close()
  })
})

describe('ReconnectController (spec §4.5.3/4)', () => {
  it('goes offline while navigator reports offline, retries on online', () => {
    const events: string[] = []
    let online = true
    const onlineListeners: Array<() => void> = []
    const offlineListeners: Array<() => void> = []
    const ctrl = new ReconnectController({
      online: () => online,
      open: () => events.push('open'),
      onOpen: () => events.push('opened'),
      onDown: () => events.push('down'),
      schedule: (ms) => events.push(`schedule:${ms}`),
      addOnlineListener: (fn) => onlineListeners.push(fn),
      addOfflineListener: (fn) => offlineListeners.push(fn),
      removeOnlineListener: () => {},
      removeOfflineListener: () => {},
    })
    ctrl.begin()
    expect(events).toEqual(['open'])

    // socket closes while offline → state offline, no retry timer
    online = false
    ctrl.down()
    expect(events).toEqual(['open', 'down'])

    // network returns → immediate reconnect attempt
    online = true
    for (const fn of onlineListeners) fn()
    expect(events.at(-1)).toBe('open')
    ctrl.stop()
  })

  it('backs off after repeated failures and stops on stop()', () => {
    vi.useFakeTimers()
    const events: string[] = []
    const onlineListeners: Array<() => void> = []
    const offlineListeners: Array<() => void> = []
    const scheduled: Array<() => void> = []
    const ctrl = new ReconnectController({
      online: () => true,
      open: () => events.push('open'),
      onOpen: () => {},
      onDown: () => events.push('down'),
      // Simulate the transport: schedule fires begin() when the timer
      // elapses.
      schedule: (ms) => {
        events.push(`schedule:${ms}`)
        scheduled.push(() => ctrl.begin())
      },
      addOnlineListener: (fn) => onlineListeners.push(fn),
      addOfflineListener: (fn) => offlineListeners.push(fn),
      removeOnlineListener: () => {},
      removeOfflineListener: () => {},
    })
    ctrl.begin()
    expect(events).toEqual(['open'])
    // open fails immediately → backoff schedule(1000)
    ctrl.down()
    expect(events).toEqual(['open', 'down', 'schedule:1000'])
    // timer fires → begin()
    const first = scheduled.shift()
    first?.()
    expect(events.at(-1)).toBe('open')
    ctrl.down()
    expect(events.at(-1)).toBe('schedule:2000')
    ctrl.stop()
    scheduled.shift()?.() // must be a no-op after stop
    expect(events.at(-1)).not.toBe('open')
    vi.useRealTimers()
  })

  it('rejects stale deliveries across a reconnect via RpcClient.reset', async () => {
    const sent: string[] = []
    const rpc = new RpcClient((t) => {
      sent.push(t)
      return true
    })
    rpc.reset(1)
    const p = rpc.request('snapshot.request', {})
    rpc.reset(2) // reconnect: reject all pending
    await expect(p).rejects.toMatchObject({ code: 'rpc/disconnected' })
  })
})
