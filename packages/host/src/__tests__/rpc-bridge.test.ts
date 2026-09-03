import { describe, it, expect, vi } from 'vitest'
import { RpcBridge } from '../ws/rpc-bridge.js'
import { RPC_DISCONNECTED_CODE, FRAME_TOO_LARGE_CODE, MAX_FRAME_BYTES, RpcError } from '../ws/rpc-bridge.js'

function makeBridge() {
  const sent: string[] = []
  const close = vi.fn()
  const bridge = new RpcBridge({
    send: (t) => sent.push(t),
    close,
    initialGeneration: 42,
    defaultTimeoutMs: 50,
  })
  return { bridge, sent, close }
}

describe('RpcBridge', () => {
  it('invoke resolves on matching rpc.result', async () => {
    const { bridge, sent, close } = makeBridge()
    const p = bridge.invoke('audit.append', { id: 1 })
    // The invoke sent a frame with requestId c:0
    expect(sent.length).toBe(1)
    expect(close).not.toHaveBeenCalled()
    const parsed = JSON.parse(sent[0]!)
    expect(parsed.op).toBe('audit.append')
    // Simulate server response
    bridge.handleInbound(JSON.stringify({
      v: 1,
      generation: 42,
      requestId: parsed.requestId,
      op: 'rpc.result',
      payload: { ok: true, data: { lastId: 1 } },
    }))
    await expect(p).resolves.toEqual({ lastId: 1 })
  })

  it('invoke rejects on timeout', async () => {
    const { bridge } = makeBridge()
    const p = bridge.invoke('audit.append', {})
    await expect(p).rejects.toBeInstanceOf(RpcError)
    await expect(p).rejects.toMatchObject({ code: 'rpc/timeout' })
  })

  it('invoke rejects when result has wrong generation', async () => {
    const { bridge, sent } = makeBridge()
    const p = bridge.invoke('audit.append', {})
    const parsed = JSON.parse(sent[0]!)
    bridge.handleInbound(JSON.stringify({
      v: 1,
      generation: 99, // mismatch
      requestId: parsed.requestId,
      op: 'rpc.result',
      payload: { ok: true, data: 1 },
    }))
    await expect(p).rejects.toMatchObject({ code: 'rpc/protocol-mismatch' })
  })

  it('invoke rejects when result op is wrong', async () => {
    const { bridge, sent } = makeBridge()
    const p = bridge.invoke('audit.append', {})
    const parsed = JSON.parse(sent[0]!)
    bridge.handleInbound(JSON.stringify({
      v: 1,
      generation: 42,
      requestId: parsed.requestId,
      op: 'audit.append', // wrong op
      payload: { ok: true, data: 1 },
    }))
    await expect(p).rejects.toMatchObject({ code: 'rpc/protocol-mismatch' })
  })

  it('disconnectAll rejects every pending entry', async () => {
    const { bridge } = makeBridge()
    const a = bridge.invoke('audit.append', {})
    const b = bridge.invoke('audit.append', {})
    bridge.disconnectAll()
    await expect(a).rejects.toMatchObject({ code: RPC_DISCONNECTED_CODE })
    await expect(b).rejects.toMatchObject({ code: RPC_DISCONNECTED_CODE })
  })

  it('oversize inbound frame triggers close + reject', async () => {
    const { bridge, close } = makeBridge()
    const pending = bridge.invoke('audit.append', {})
    const huge = 'x'.repeat(MAX_FRAME_BYTES + 10)
    bridge.handleInbound(huge)
    expect(close).toHaveBeenCalledWith(1008, 'frame too large')
    await expect(pending).rejects.toMatchObject({ code: RPC_DISCONNECTED_CODE })
  })

  it('oversize outbound frame converts to payload/too-large notification', () => {
    const { bridge, sent } = makeBridge()
    const huge = 'x'.repeat(MAX_FRAME_BYTES + 10)
    const ok = bridge.sendNotification('audit.append', { text: huge })
    expect(ok).toBe(false)
    // last sent frame is an error with FRAME_TOO_LARGE_CODE
    const last = JSON.parse(sent.at(-1)!)
    expect(last.op).toBe('error')
    expect(last.payload.error.code).toBe(FRAME_TOO_LARGE_CODE)
  })

  it('invoke after disconnect rejects with rpc/disconnected', async () => {
    const { bridge } = makeBridge()
    bridge.disconnectAll()
    await expect(bridge.invoke('audit.append', {})).rejects.toMatchObject({
      code: RPC_DISCONNECTED_CODE,
    })
  })
})