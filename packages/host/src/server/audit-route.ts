/**
 * GET /api/audit — return current audit records (spec §4.3 / §8.4).
 *
 * Query params (all optional):
 *   sinceId?:   number  — return records strictly newer than this id
 *   lastId?:    number  — return only `{ lastId }` (cheap polling)
 *   method?:    string  — exact match on HTTP method (GET|POST|PUT|PATCH|DELETE)
 *   status?:    number  — exact match on response status (200, 404, ...)
 *   url?:       string  — substring match on request url
 *   initiator?: string  — substring match on initiator (core|replay:<id>|<pluginId>)
 *   limit?:     number  — max records returned (after filter, before/after order)
 *   order?:     'asc' | 'desc' — sort by id; default 'desc' (newest first)
 *
 * Response: { ok: true, data: { lastId, records } } where records is already
 * filtered + ordered + limited. `lastId` is ALWAYS the ring buffer's current
 * lastId (not the max of the returned window) — cheap polling consumers read
 * it regardless of filter.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendText } from './http-utils.js'
import type { AuditRingBuffer } from '../client/ring-buffer.js'
import type { AuditRecord } from '../client/audit-record.js'

export interface AuditRouteDeps {
  ringBuffer: AuditRingBuffer<AuditRecord>
}

export interface AuditQuery {
  sinceId?: number
  method?: string
  status?: number
  url?: string
  initiator?: string
  limit?: number
  order?: 'asc' | 'desc'
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

export function parseAuditQuery(search: URLSearchParams): { query: AuditQuery } | { error: { code: string; message: string } } {
  const query: AuditQuery = {}

  const sinceIdRaw = search.get('sinceId')
  if (sinceIdRaw !== null) {
    const sinceId = Number(sinceIdRaw)
    if (!Number.isFinite(sinceId) || sinceId < 0) {
      return { error: { code: 'audit/bad-sinceId', message: 'sinceId must be a non-negative number' } }
    }
    query.sinceId = sinceId
  }

  const methodRaw = search.get('method')
  if (methodRaw !== null) {
    const method = methodRaw.toUpperCase()
    if (!METHODS.has(method)) {
      return { error: { code: 'audit/bad-method', message: `method must be one of ${[...METHODS].join(', ')}` } }
    }
    query.method = method
  }

  const statusRaw = search.get('status')
  if (statusRaw !== null) {
    const status = Number(statusRaw)
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      return { error: { code: 'audit/bad-status', message: 'status must be an integer in [100, 599]' } }
    }
    query.status = status
  }

  const urlRaw = search.get('url')
  if (urlRaw !== null) query.url = urlRaw

  const initiatorRaw = search.get('initiator')
  if (initiatorRaw !== null) query.initiator = initiatorRaw

  const limitRaw = search.get('limit')
  if (limitRaw !== null) {
    const limit = Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      return { error: { code: 'audit/bad-limit', message: 'limit must be an integer in [1, 10000]' } }
    }
    query.limit = limit
  }

  const orderRaw = search.get('order')
  if (orderRaw !== null) {
    if (orderRaw !== 'asc' && orderRaw !== 'desc') {
      return { error: { code: 'audit/bad-order', message: "order must be 'asc' or 'desc'" } }
    }
    query.order = orderRaw
  }

  return { query }
}

/** Apply filter → sort → limit to a full record list. Shared by the REST
 * route and the CLI cold-start domain read so both sides behave identically. */
export function applyAuditQuery(records: AuditRecord[], query: AuditQuery): AuditRecord[] {
  let out = records

  if (query.sinceId !== undefined) {
    out = out.filter((r) => r.id > query.sinceId!)
  }
  if (query.method !== undefined) {
    out = out.filter((r) => r.method === query.method)
  }
  if (query.status !== undefined) {
    out = out.filter((r) => r.status === query.status)
  }
  if (query.url !== undefined) {
    out = out.filter((r) => r.url.includes(query.url!))
  }
  if (query.initiator !== undefined) {
    out = out.filter((r) => r.initiator.includes(query.initiator!))
  }

  // Sort by id; desc = newest first.
  const order = query.order ?? 'desc'
  out = [...out].sort((a, b) => (order === 'desc' ? b.id - a.id : a.id - b.id))

  if (query.limit !== undefined && out.length > query.limit) {
    out = out.slice(0, query.limit)
  }
  return out
}

export function handleAuditRoute(deps: AuditRouteDeps, req: IncomingMessage, res: ServerResponse, urlPath: string): void {
  if (req.method !== 'GET') {
    sendText(res, 405, 'method not allowed')
    return
  }
  const url = new URL(urlPath, 'http://localhost')
  const lastIdRaw = url.searchParams.get('lastId')

  if (lastIdRaw !== null) {
    sendJson(res, 200, { ok: true, data: { lastId: deps.ringBuffer.lastId } })
    return
  }

  const parsed = parseAuditQuery(url.searchParams)
  if ('error' in parsed) {
    sendJson(res, 400, { ok: false, error: parsed.error })
    return
  }

  const records = applyAuditQuery(deps.ringBuffer.snapshot(), parsed.query)
  sendJson(res, 200, { ok: true, data: { lastId: deps.ringBuffer.lastId, records } })
}
