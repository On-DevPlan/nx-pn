import { describe, it, expect } from 'vitest'
import { HostAuditClient } from '../client/audit-client.js'
import { AuditRingBuffer } from '../client/ring-buffer.js'
import type { AuditRecord } from '../client/audit-record.js'

function makeFetchStub(body: string, status = 200, contentType = 'application/json'): typeof fetch {
  return (async (_url: string, init?: RequestInit): Promise<Response> => {
    return new Response(body, {
      status,
      statusText: 'OK',
      headers: { 'content-type': contentType },
    })
  }) as typeof fetch
}

describe('HostAuditClient', () => {
  it('get calls fetch and pushes a record', async () => {
    const buf = new AuditRingBuffer<AuditRecord>()
    const client = new HostAuditClient({ buffer: buf, fetchImpl: makeFetchStub('hi') })
    const res = await client.get('https://example.com/api')
    expect(res.status).toBe(200)
    expect(res.bodyText).toBe('hi')
    expect(res.bodyJson).toBeUndefined()
    const records = buf.snapshot()
    expect(records).toHaveLength(1)
    expect(records[0]!.method).toBe('GET')
    expect(records[0]!.url).toBe('https://example.com/api')
    expect(records[0]!.initiator).toBe('core')
  })

  it('parses JSON body when content-type is JSON', async () => {
    const buf = new AuditRingBuffer<AuditRecord>()
    const client = new HostAuditClient({ buffer: buf, fetchImpl: makeFetchStub('{"a":1}') })
    const res = await client.get('https://example.com')
    expect(res.bodyJson).toEqual({ a: 1 })
  })

  it('serialises a string body for POST', async () => {
    let captured: RequestInit | undefined
    const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
      captured = init
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const buf = new AuditRingBuffer<AuditRecord>()
    const client = new HostAuditClient({ buffer: buf, fetchImpl })
    await client.post('https://x', { hello: 'world' })
    expect(captured?.method).toBe('POST')
    expect(captured?.body).toBe('{"hello":"world"}')
    const records = buf.snapshot()
    expect(records[0]!.reqBody.text).toBe('{"hello":"world"}')
  })

  it('redacts sensitive headers before fetch', async () => {
    let captured: RequestInit | undefined
    const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
      captured = init
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const buf = new AuditRingBuffer<AuditRecord>()
    const client = new HostAuditClient({ buffer: buf, fetchImpl })
    await client.get('https://x', { headers: { Authorization: 'Bearer secret' } })
    const headers = captured?.headers as Record<string, string>
    expect(headers['authorization']).toMatch(/present.*true/)
    const records = buf.snapshot()
    expect(records[0]!.reqHeaders['authorization']).toMatch(/present.*true/)
  })
})