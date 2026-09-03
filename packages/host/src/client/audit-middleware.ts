/**
 * Audit middleware — outermost in the onion chain. Spec §3.2 / §4.2.
 *
 *   1. Apply credential redaction on the inbound headers BEFORE the fetch
 *      is sent (and BEFORE the record is constructed) — this guarantees
 *      secrets never appear in the stored record even on error paths.
 *   2. After `next()` resolves, build an AuditRecord and push it to the
 *      ring buffer.
 *
 * The middleware deliberately swallows record-write errors so a bad ring
 * buffer can never propagate back into user code.
 */

import type { MiddlewareContext, Next, Middleware } from '@flowot/nx-pn-core'
import { MAX_BODY_BYTES } from '@flowot/nx-pn-core'
import { redactCredentials } from '@flowot/nx-pn-core'

import type { AuditRecord } from './audit-record.js'
import type { AuditRingBuffer } from './ring-buffer.js'

export interface AuditMiddlewareDeps {
  buffer: AuditRingBuffer<AuditRecord>
}

interface ResEnvelope {
  _auditStatus: number
  _auditStatusText: string
  _auditHeaders: Record<string, string>
  _auditBodyText: string
  _auditBodyBytes: number
  _auditBodyTruncated: boolean
  _auditBodyJson?: unknown
}

export type { ResEnvelope }

export function createAuditMiddleware(deps: AuditMiddlewareDeps): Middleware<MiddlewareContext, ResEnvelope> {
  const { buffer } = deps
  return async function auditMiddleware(ctx: MiddlewareContext, next: Next): Promise<ResEnvelope> {
    const start = Date.now()
    // (1) Redact BEFORE building the record (also redacts the live request).
    const { headers: redactedHeaders } = redactCredentials(ctx.headers)

    // Persist redacted headers on the context for any downstream middleware.
    ctx.headers = redactedHeaders

    let response: ResEnvelope | undefined
    let caughtError: unknown

    try {
      const result = (await next()) as ResEnvelope
      response = result
    } catch (err) {
      caughtError = err
    }

    const durationMs = Date.now() - start

    // (2) Build the record regardless of outcome.
    const reqBodyText = ctx.body ?? ''
    const reqBytes = byteLength(reqBodyText)
    const reqTruncated = reqBytes > MAX_BODY_BYTES

    const reqBody = {
      text: reqTruncated ? reqBodyText.slice(0, MAX_BODY_BYTES) : reqBodyText,
      truncated: reqTruncated,
      bytes: reqBytes,
    }

    const record: AuditRecord = {
      id: 0, // assigned by push()
      ts: Date.now(),
      initiator: ctx.initiator,
      method: ctx.method,
      url: ctx.url,
      reqHeaders: { ...redactedHeaders },
      reqBody,
      status: response?._auditStatus ?? 0,
      statusText: response?._auditStatusText ?? '',
      resHeaders: response?._auditHeaders ? { ...response._auditHeaders } : {},
      resBody: {
        text: response?._auditBodyText ?? '',
        truncated: response?._auditBodyTruncated ?? false,
        bytes: response?._auditBodyBytes ?? 0,
      },
      durationMs,
    }
    if (response?._auditBodyJson !== undefined) {
      record.resBody.json = response._auditBodyJson
    }
    // Derive replayOf from the initiator prefix `replay:<id>` (spec §4.7).
    const replayMatch = /^replay:(\d+)$/.exec(ctx.initiator)
    if (replayMatch) {
      record.replayOf = Number(replayMatch[1])
    }

    if (caughtError !== undefined) {
      const errObj = caughtError instanceof Error ? caughtError : new Error(String(caughtError))
      record.error = { name: errObj.name || 'Error', message: errObj.message }
    }

    try {
      buffer.push(record)
    } catch {
      // never let record-write errors propagate
    }

    if (caughtError !== undefined) {
      throw caughtError
    }
    return response!
  }
}

/** UTF-8 byte length of a string (BOM-safe). */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8')
}