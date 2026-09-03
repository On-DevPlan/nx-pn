import { describe, it, expect, vi } from 'vitest'
import { ClientAuditClientProxy } from '../audit/client-proxy.js'
import { RpcClient } from '../rpc/rpc-client.js'

function makeProxy(pluginRunId = 'run-1') {
  const frames: Array<{ requestId: string; op: string; payload: Record<string, unknown> }> = []
  const rpc = new RpcClient((text) => {
    frames.push(JSON.parse(text))
    return true
  })
  rpc.reset(1)
  const proxy = new ClientAuditClientProxy(rpc, { pluginRunId })
  return { proxy, rpc, frames }
}

/** Resolve the single outstanding pending request with a result payload. */
function answer(rpc: RpcClient, data: unknown, error?: { code: string; message?: string }) {
  const requestId = (rpc as unknown as { pending: Map<string, unknown> }).pending.keys().next().value as string
  rpc.handleFrame({
    v: 1,
    generation: 1,
    requestId,
    op: 'rpc.result',
    payload: error ? { ok: false, error } : { ok: true, data },
  })
}

describe('ClientAuditClientProxy (spec §5.5)', () => {
  it('forwards a GET as an rpc.invoke frame with the bound pluginRunId', async () => {
    const { proxy, frames } = makeProxy('run-9')
    const p = proxy.get('https://example.com/x', { headers: { a: 'b' } })
    expect(frames).toHaveLength(1)
    expect(frames[0]?.op).toBe('rpc.invoke')
    expect(frames[0]?.payload).toMatchObject({
      method: 'GET',
      url: 'https://example.com/x',
      pluginRunId: 'run-9',
      config: { headers: { a: 'b' } },
    })
    answer(proxy.rpcRef(), { status: 204, statusText: 'No Content', headers: {}, bytes: 0, truncated: false, bodyText: '' })
    await expect(p).resolves.toMatchObject({ status: 204 })
  })

  it('parses the host response envelope into an AuditResponse', async () => {
    const { proxy } = makeProxy()
    const p = proxy.get('http://h/x')
    answer(proxy.rpcRef(), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      bytes: 12,
      truncated: false,
      bodyText: '{"a":1}',
      bodyJson: { a: 1 },
    })
    await expect(p).resolves.toMatchObject({
      status: 200,
      statusText: 'OK',
      bodyText: '{"a":1}',
      bodyJson: { a: 1 },
    })
  })

  it('setPluginRunId rebinds subsequent requests', async () => {
    const { proxy, frames } = makeProxy('run-old')
    proxy.setPluginRunId('run-new')
    const p = proxy.post('http://h/x', { q: 1 })
    expect(frames[0]?.payload).toMatchObject({ method: 'POST', pluginRunId: 'run-new' })
    answer(proxy.rpcRef(), { status: 201, statusText: 'Created', headers: {}, bytes: 0, truncated: false, bodyText: '' })
    await expect(p).resolves.toMatchObject({ status: 201 })
  })

  it('translates a stale-run host error into a local RpcError', async () => {
    const { proxy } = makeProxy('run-old')
    const p = proxy.delete('http://h/x')
    answer(proxy.rpcRef(), undefined, { code: 'stale-run', message: 'run no longer active' })
    await expect(p).rejects.toMatchObject({ code: 'stale-run' })
  })

  it('reports malformed host payloads as errors', async () => {
    const { proxy } = makeProxy()
    const p = proxy.get('http://h/x')
    // resolve the pending entry but skip the real answer helper: answer
    // with a non-object payload (server should never do this).
    const requestId = (proxy.rpcRef() as unknown as { pending: Map<string, unknown> }).pending.keys().next().value as string
    proxy.rpcRef().handleFrame({ v: 1, generation: 1, requestId, op: 'rpc.result', payload: { ok: true, data: 'nonsense' } })
    await expect(p).rejects.toMatchObject({ message: 'malformed audit response' })
  })
})
