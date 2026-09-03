import { describe, it, expect } from 'vitest'
import { AuditRingBuffer } from '../client/ring-buffer.js'
import { createAuditMiddleware, type ResEnvelope } from '../client/audit-middleware.js'
import type { MiddlewareContext } from '@flowot/nx-pn-core'

function fakeEnvelope(body: string, status = 200): ResEnvelope {
  return {
    _auditStatus: status,
    _auditStatusText: 'OK',
    _auditHeaders: { 'content-type': 'application/json' },
    _auditBodyText: body,
    _auditBodyBytes: Buffer.byteLength(body),
    _auditBodyTruncated: false,
  }
}

describe('auditMiddleware', () => {
  it('redacts credentials on the request headers and produces a record', async () => {
    const buf = new AuditRingBuffer<import('../client/audit-record.js').AuditRecord>()
    const mw = createAuditMiddleware({ buffer: buf })
    const ctx: MiddlewareContext = {
      method: 'GET',
      url: 'https://example.com/api',
      initiator: 'plugin:foo',
      headers: { Authorization: 'Bearer abc', 'x-trace': '1' },
    }
    const envelope = await mw(ctx, async () => fakeEnvelope('hello'))
    expect(envelope._auditStatus).toBe(200)
    const records = buf.snapshot()
    expect(records).toHaveLength(1)
    expect(records[0]!.initiator).toBe('plugin:foo')
    expect(records[0]!.reqHeaders['authorization']).toMatch(/present.*true/)
    expect(records[0]!.reqHeaders['x-trace']).toBe('1')
    // The live ctx headers were redacted too.
    expect((ctx.headers['authorization'] as string)).toMatch(/present.*true/)
  })

  it('records network errors with status 0', async () => {
    const buf = new AuditRingBuffer<import('../client/audit-record.js').AuditRecord>()
    const mw = createAuditMiddleware({ buffer: buf })
    const ctx: MiddlewareContext = {
      method: 'POST',
      url: 'https://broken.example',
      initiator: 'replay:1',
      headers: {},
      body: 'x',
    }
    await expect(mw(ctx, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    const records = buf.snapshot()
    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe(0)
    expect(records[0]!.error?.message).toBe('boom')
  })

  it('does not throw if the ring buffer itself throws', async () => {
    const mw = createAuditMiddleware({
      buffer: {
        push: () => { throw new Error('disk full') },
        snapshot: () => [],
        since: () => [],
        get: () => undefined,
        size: 0,
        lastId: 0,
        clear: () => {},
      } as unknown as AuditRingBuffer<import('../client/audit-record.js').AuditRecord>,
    })
    const ctx: MiddlewareContext = {
      method: 'GET',
      url: 'https://example.com',
      initiator: 'core',
      headers: {},
    }
    await expect(mw(ctx, async () => fakeEnvelope('ok'))).resolves.toBeDefined()
  })
})