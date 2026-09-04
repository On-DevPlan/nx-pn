/**
 * POST /api/replay — replay a prior audit record (spec §6 / §3.1).
 *
 * Body: {
 *   recordId: number,
 *   overrides?: { method?, url?, headers?, body? }
 * }
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sendJson, BodyTooLargeError } from './http-utils.js'
import type { AuditRingBuffer } from '../client/ring-buffer.js'
import type { AuditRecord } from '../client/audit-record.js'
import type { HostAuditClient } from '../client/audit-client.js'
import type { MiddlewareContext } from '@flowot/nx-pn-core'
import type { Domain } from '@flowot/nx-pn-storage-domain'
import type { AuditSpec } from '../domains/audit-domain.js'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ReplayRouteDeps {
  ringBuffer: AuditRingBuffer<AuditRecord>
  client: HostAuditClient
  /**
   * Durable audit domain — the fallback when the live buffer no longer
   * holds the requested id (evicted, or from before a restart). Optional
   * for tests; without it the buffer is the whole ledger.
   */
  auditDomain?: Domain<AuditSpec>
}

const MAX_BODY = 1 * 1024 * 1024

export async function handleReplayRoute(deps: ReplayRouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'method/not-allowed', message: 'POST only' } })
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_BODY)
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { ok: false, error: { code: 'replay/body-too-large', message: err.message } })
      return
    }
    sendJson(res, 400, { ok: false, error: { code: 'replay/bad-json', message: (err as Error).message } })
    return
  }
  if (!body || typeof body !== 'object') {
    sendJson(res, 400, { ok: false, error: { code: 'replay/missing-body', message: 'JSON body required' } })
    return
  }
  const reqBody = body as { recordId?: unknown; overrides?: Partial<RecordOverrides> }
  const recordId = Number(reqBody.recordId)
  if (!Number.isFinite(recordId)) {
    sendJson(res, 400, { ok: false, error: { code: 'replay/bad-recordId', message: 'recordId required' } })
    return
  }
  // Window first; on a miss fall back to the durable audit domain (the
  // id may predate this process or have been evicted from the buffer).
  // AuditStoreService.get stays synchronous (buffer-only) — the async
  // fallback lives here, the one call site that can await.
  let record = deps.ringBuffer.get(recordId)
  if (!record && deps.auditDomain) {
    try {
      const stored = deps.auditDomain.table('records').get(String(recordId))
      if (stored !== undefined) {
        record = { ...(stored as AuditRecord), id: Number(recordId) }
      }
    } catch {
      // closed domain / unreadable record — treat as not found
    }
  }
  if (!record) {
    sendJson(res, 404, { ok: false, error: { code: 'replay/record-not-found', message: 'no such record' } })
    return
  }

  const overrides = reqBody.overrides ?? {}
  const method = ((overrides.method as HttpMethod | undefined) ?? record.method) as HttpMethod
  const url = overrides.url ?? record.url
  const headers = { ...record.reqHeaders, ...(overrides.headers ?? {}) }

  const ctx: MiddlewareContext = {
    method,
    url,
    initiator: `replay:${recordId}`,
    headers,
  }
  // GET cannot carry a body (HTTP spec / fetch will throw). If the user
  // overrode the method to GET, drop any body — both from the outbound
  // request and from the audit record. Replays without a method override
  // inherit the original method, which already implies whether a body
  // makes sense.
  if (method === 'GET') {
    ctx.body = ''
  } else if (overrides.body !== undefined) ctx.body = String(overrides.body)
  else if (record.reqBody.text) ctx.body = record.reqBody.text

  try {
    // Go through the SAME middleware chain as normal requests (spec §4.7);
    // the audit middleware records the replay with initiator
    // `replay:<recordId>` and derives replayOf on the new record.
    const out = await deps.client.request(ctx)
    sendJson(res, 200, { ok: true, data: out })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: { code: 'replay/failed', message: (err as Error).message } })
  }
}

interface RecordOverrides {
  method?: HttpMethod
  url?: string
  headers?: Record<string, string>
  body?: string
}