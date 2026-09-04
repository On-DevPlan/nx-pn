/**
 * Audit middleware — outermost in the onion chain. Spec §3.2 / §4.2.
 *
 *   1. Apply credential redaction on the inbound headers BEFORE the fetch
 *      is sent (and BEFORE the record is constructed) — this guarantees
 *      secrets never appear in the stored record even on error paths.
 *   2. After `next()` resolves, build an AuditRecord and push it to the
 *      ring buffer.
 *
 * Optional durable persistence: when `persist` is provided, the record is
 * FIRST durably stored (the audit domain put under `String(id)`) and only
 * on success pushed into the ring buffer + broadcast. A persist
 * failure is swallowed — the audit workbench can never block the business
 * request it describes — but it also means the record is in NEITHER the
 * medium nor the buffer (read/write consistency: memory state equals medium
 * state). The record id is allocated via `buffer.nextId()` before persist so
 * the domain key is stable; `buffer.push` preserves the pre-assigned id.
 */

import type { MiddlewareContext, Next, Middleware } from '@flowot/nx-pn-core'
import { MAX_BODY_BYTES } from '@flowot/nx-pn-core'
import { redactCredentials } from '@flowot/nx-pn-core'

import type { AuditRecord } from './audit-record.js'
import type { AuditRingBuffer } from './ring-buffer.js'

export interface AuditMiddlewareDeps {
  buffer: AuditRingBuffer<AuditRecord>
  /**
   * Optional durable write (audit domain put). Runs AFTER the id is
   * allocated and BEFORE `buffer.push` — a rejected persist leaves the
   * record in neither the medium nor the buffer.
   */
  persist?: (record: AuditRecord) => Promise<void>
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
  /**
   * Single write chain for the record path (id allocation → durable
   * persist → buffer push). Serialization is REQUIRED, not an
   * optimization: `nextId()` derives from the buffer's last entry, so an
   * `await` between allocation and push would let two concurrent requests
   * allocate the same id, and out-of-order pushes would regress `lastId`.
   * Every link settles inside the chain — a failed persist is swallowed
   * (the audit workbench must not reject the business request) and the
   * chain itself never rejects.
   */
  let chain: Promise<void> = Promise.resolve()
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
      id: 0, // assigned by nextId() on the write chain below
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

    // Durable path: allocate the id first (domain key = String(id)),
    // persist, then push — serialized on the chain above so ids stay
    // unique, pushes stay ordered, and push only fires onPush (the WS
    // broadcast) after the record is durable.
    chain = chain
      .then(async () => {
        record.id = buffer.nextId()
        await deps.persist?.(record)
        buffer.push(record)
      })
      .then(
        () => undefined,
        () => {
          // never let record-write errors propagate — a failed persist
          // means the record is in neither the medium nor the buffer
          // (read/write consistency: memory state equals medium state).
        },
      )
    await chain

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