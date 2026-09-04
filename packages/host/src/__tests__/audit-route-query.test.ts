import { describe, expect, it } from 'vitest'
import { AuditRingBuffer } from '../client/ring-buffer.js'
import type { AuditRecord } from '../client/audit-record.js'
import { applyAuditQuery, parseAuditQuery } from '../server/audit-route.js'

/** Build a record with only the fields the query predicates touch. */
function rec(partial: Partial<AuditRecord> & { id: number }): AuditRecord {
  return {
    ts: 0,
    initiator: 'core',
    method: 'GET',
    url: 'http://example.com/',
    reqHeaders: {},
    reqBody: { text: '', truncated: false, bytes: 0 },
    status: 200,
    statusText: 'OK',
    resHeaders: {},
    resBody: { text: '', truncated: false, bytes: 0 },
    durationMs: 1,
    ...partial,
  }
}

function bufferOf(records: AuditRecord[]): AuditRingBuffer<AuditRecord> {
  const b = new AuditRingBuffer<AuditRecord>({ capacity: 100 })
  b.rebuild(records)
  return b
}

describe('parseAuditQuery', () => {
  it('parses an empty query to defaults (no filter, desc order)', () => {
    const r = parseAuditQuery(new URLSearchParams())
    expect('query' in r).toBe(true)
    if ('query' in r) expect(r.query).toEqual({})
  })

  it('parses all predicates', () => {
    const r = parseAuditQuery(new URLSearchParams('sinceId=3&method=post&status=201&url=api&initiator=echo&limit=7&order=asc'))
    expect('query' in r).toBe(true)
    if ('query' in r) {
      expect(r.query).toEqual({
        sinceId: 3,
        method: 'POST',
        status: 201,
        url: 'api',
        initiator: 'echo',
        limit: 7,
        order: 'asc',
      })
    }
  })

  it('rejects bad method / status / limit / order', () => {
    expect('error' in parseAuditQuery(new URLSearchParams('method=FOO'))).toBe(true)
    expect('error' in parseAuditQuery(new URLSearchParams('status=42'))).toBe(true)
    expect('error' in parseAuditQuery(new URLSearchParams('limit=0'))).toBe(true)
    expect('error' in parseAuditQuery(new URLSearchParams('order=sideways'))).toBe(true)
  })
})

describe('applyAuditQuery', () => {
  const records = [
    rec({ id: 1, method: 'GET', status: 200, url: 'http://x/a', initiator: 'core' }),
    rec({ id: 2, method: 'POST', status: 201, url: 'http://x/b', initiator: 'echo' }),
    rec({ id: 3, method: 'GET', status: 404, url: 'http://x/c', initiator: 'replay:1' }),
    rec({ id: 4, method: 'DELETE', status: 204, url: 'http://x/a', initiator: 'core' }),
    rec({ id: 5, method: 'GET', status: 200, url: 'http://x/d', initiator: 'echo' }),
  ]

  it('default order is desc (newest first)', () => {
    const out = applyAuditQuery(records, {})
    expect(out.map((r) => r.id)).toEqual([5, 4, 3, 2, 1])
  })

  it('order asc sorts oldest first', () => {
    const out = applyAuditQuery(records, { order: 'asc' })
    expect(out.map((r) => r.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('filters by method (case from parse is uppercase)', () => {
    const out = applyAuditQuery(records, { method: 'GET' })
    expect(out.map((r) => r.id)).toEqual([5, 3, 1])
  })

  it('filters by status exact', () => {
    const out = applyAuditQuery(records, { status: 200 })
    expect(out.map((r) => r.id)).toEqual([5, 1])
  })

  it('filters by url substring', () => {
    const out = applyAuditQuery(records, { url: '/a' })
    expect(out.map((r) => r.id)).toEqual([4, 1])
  })

  it('filters by initiator substring', () => {
    const out = applyAuditQuery(records, { initiator: 'replay' })
    expect(out.map((r) => r.id)).toEqual([3])
  })

  it('combines predicates (method + status + limit)', () => {
    const out = applyAuditQuery(records, { method: 'GET', limit: 2 })
    expect(out.map((r) => r.id)).toEqual([5, 3])
  })

  it('sinceId returns strictly newer records', () => {
    const out = applyAuditQuery(records, { sinceId: 3 })
    expect(out.map((r) => r.id)).toEqual([5, 4])
  })

  it('limit applies after sort', () => {
    const out = applyAuditQuery(records, { limit: 2, order: 'asc' })
    expect(out.map((r) => r.id)).toEqual([1, 2])
  })

  it('is pure — does not mutate the input', () => {
    const snapshot = records.slice()
    applyAuditQuery(records, { method: 'GET', order: 'asc' })
    expect(records).toEqual(snapshot)
  })
})
