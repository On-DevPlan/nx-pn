/**
 * GET /api/audit — return current audit records (spec §4.3 / §8.4).
 *
 * Query params:
 *   sinceId?: number — return records strictly newer than this id
 *   lastId?:   number — return only `{ lastId }` (cheap polling)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendText } from './http-utils.js'
import type { AuditRingBuffer } from '../client/ring-buffer.js'
import type { AuditRecord } from '../client/audit-record.js'

export interface AuditRouteDeps {
  ringBuffer: AuditRingBuffer<AuditRecord>
}

export function handleAuditRoute(deps: AuditRouteDeps, req: IncomingMessage, res: ServerResponse, urlPath: string): void {
  if (req.method !== 'GET') {
    sendText(res, 405, 'method not allowed')
    return
  }
  const url = new URL(urlPath, 'http://localhost')
  const sinceIdRaw = url.searchParams.get('sinceId')
  const lastIdRaw = url.searchParams.get('lastId')

  if (lastIdRaw !== null) {
    sendJson(res, 200, { ok: true, data: { lastId: deps.ringBuffer.lastId } })
    return
  }

  let records: AuditRecord[]
  if (sinceIdRaw !== null) {
    const sinceId = Number(sinceIdRaw)
    if (!Number.isFinite(sinceId)) {
      sendJson(res, 400, { ok: false, error: { code: 'audit/bad-sinceId', message: 'sinceId must be a number' } })
      return
    }
    records = deps.ringBuffer.since(sinceId)
  } else {
    records = deps.ringBuffer.snapshot()
  }

  sendJson(res, 200, { ok: true, data: { lastId: deps.ringBuffer.lastId, records } })
}