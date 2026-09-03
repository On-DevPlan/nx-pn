import { describe, it, expect, vi, afterEach } from 'vitest'
import { RpcClient } from '../rpc/rpc-client.js'
import { RpcError } from '../rpc/rpc-client.js'

function makeClient() {
  const sent: string[] = []
  const rpc = new RpcClient(
    (text) => {
      sent.push(text)
      return true
    },
    { defaultTimeoutMs: 40 },
  )
  rpc.reset(42)
  return { rpc, sent }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RpcClient', () => {
  it('request resolves with the server data payload on matching rpc.result', async () => {
    const { rpc, sent } = makeClient()
    const p = rpc.request('snapshot.request', { sinceId: 0 })
    expect(sent).toHaveLength(1)
    const frame = JSON.parse(sent[0]!)
    expect(frame.op).toBe('snapshot.request')
    rpc.handleFrame({
      v: 1,
      generation: 42,
      requestId: frame.requestId,
      op: 'rpc.result',
      payload: { ok: true, data: { lastId: 7 } },
    })
    await expect(p).resolves.toEqual({ lastId: 7 })
  })

  it('request rejects when the server reports ok:false', async () => {
    const { rpc, sent } = makeClient()
    const p = rpc.request('rpc.invoke', {})
    const frame = JSON.parse(sent[0]!)
    rpc.handleFrame({
      v: 1,
      generation: 42,
      requestId: frame.requestId,
      op: 'rpc.result',
      payload: { ok: false, error: { code: 'stale-run', message: 'old run' } },
    })
    await expect(p).rejects.toBeInstanceOf(RpcError)
    await expect(p).rejects.toMatchObject({ code: 'stale-run' })
  })

  it('request rejects on timeout (30s default / per-request override)', async () => {
    vi.useFakeTimers()
    const { rpc } = makeClient()
    const p = rpc.request('snapshot.request', {})
    vi.advanceTimersByTime(41)
    await expect(p).rejects.toMatchObject({ code: 'rpc/timeout' })
  })

  it('request rejects on generation mismatch (stale response)', async () => {
    const { rpc, sent } = makeClient()
    const p = rpc.request('snapshot.request', {})
    const frame = JSON.parse(sent[0]!)
    rpc.handleFrame({
      v: 1,
      generation: 99,
      requestId: frame.requestId,
      op: 'rpc.result',
      payload: { ok: true, data: 1 },
    })
    await expect(p).rejects.toMatchObject({ code: 'rpc/protocol-mismatch' })
  })

  it('request rejects when a non-result op answers a pending requestId', async () => {
    const { rpc, sent } = makeClient()
    const p = rpc.request('snapshot.request', {})
    const frame = JSON.parse(sent[0]!)
    rpc.handleFrame({ v: 1, generation: 42, requestId: frame.requestId, op: 'audit.append', payload: {} })
    await expect(p).rejects.toMatchObject({ code: 'rpc/protocol-mismatch' })
  })

  it('disconnectAll rejects every pending request with rpc/disconnected', async () => {
    const { rpc } = makeClient()
    const a = rpc.request('snapshot.request', {})
    const b = rpc.request('snapshot.request', {})
    rpc.disconnectAll()
    await expect(a).rejects.toMatchObject({ code: 'rpc/disconnected' })
    await expect(b).rejects.toMatchObject({ code: 'rpc/disconnected' })
  })

  it('reset rejects old pending entries but allows new requests', async () => {
    const { rpc, sent } = makeClient()
    const old = rpc.request('snapshot.request', {})
    rpc.reset(43)
    await expect(old).rejects.toMatchObject({ code: 'rpc/disconnected' })
    const p = rpc.request('snapshot.request', {})
    expect(sent).toHaveLength(2)
    // old generation response must not satisfy the new request
    const frame = JSON.parse(sent[1]!)
    expect(frame.generation).toBe(43)
    rpc.handleFrame({ v: 1, generation: 42, requestId: frame.requestId, op: 'rpc.result', payload: { ok: true, data: 1 } })
    await expect(p).rejects.toMatchObject({ code: 'rpc/protocol-mismatch' })
  })

  it('request after close rejects immediately', async () => {
    const { rpc } = makeClient()
    rpc.close()
    await expect(rpc.request('snapshot.request', {})).rejects.toMatchObject({ code: 'rpc/disconnected' })
  })

  it('oversized outbound frame is rejected with payload/too-large', async () => {
    const rpc = new RpcClient(() => true, {})
    rpc.reset(1)
    const huge = 'x'.repeat(16 * 1024 * 1024 + 10)
    await expect(rpc.request('snapshot.request', { blob: huge })).rejects.toMatchObject({
      code: 'payload/too-large',
    })
  })
})
