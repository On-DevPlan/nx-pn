/**
 * HostAuditClient — the undici + onion-middleware implementation of
 * AuditClient (spec §3.1 / §4.2).
 *
 * Composition order (outermost → innermost):
 *
 *   audit-middleware  →  (future middlewares)  →  performFetch
 *
 * `performFetch` is the terminal handler. It buffers the response body up
 * to MAX_BODY_BYTES, performs JSON detection, and returns the response
 * envelope that the audit middleware knows how to read.
 */

import { Buffer } from 'node:buffer'
import { fetch, Agent, type Dispatcher } from 'undici'
import {
  type AuditResponse,
  type Middleware,
  type MiddlewareContext,
  compose,
  MAX_BODY_BYTES,
} from '@api-audit/core'

import type { AuditRingBuffer } from './ring-buffer.js'
import type { AuditRecord } from './audit-record.js'
import { createAuditMiddleware, type ResEnvelope } from './audit-middleware.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface HostAuditClientOptions {
  /** Underlying undici dispatcher; defaults to a fresh Agent. */
  dispatcher?: Dispatcher
  /** Per-request buffer; passed to the audit middleware. */
  buffer: AuditRingBuffer<AuditRecord>
  /** Override the fetch implementation (tests). */
  fetchImpl?: typeof fetch
}

export interface RunConfig {
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Audit initiator override. The cordis `auditClient` service sets this
   * from the calling plugin's fiber (spec §7.4 attribution); direct
   * callers leave it unset and get `'core'`. Replay uses
   * `client.request(ctx)` with an explicit initiator instead.
   */
  initiator?: string
}

export class HostAuditClient {
  private readonly dispatcher: Dispatcher | undefined
  private readonly fetchImpl: typeof fetch
  private readonly chain: (ctx: MiddlewareContext) => Promise<ResEnvelope>
  private readonly buffer: AuditRingBuffer<AuditRecord>
  private ownsDispatcher = false

  constructor(opts: HostAuditClientOptions) {
    this.buffer = opts.buffer
    if (opts.dispatcher) {
      this.dispatcher = opts.dispatcher
      this.ownsDispatcher = false
    } else {
      this.dispatcher = new Agent({})
      this.ownsDispatcher = true
    }
    this.fetchImpl = opts.fetchImpl ?? (fetch as typeof fetch)

    const auditMw = createAuditMiddleware({ buffer: opts.buffer })
    const middlewares: Middleware<MiddlewareContext, ResEnvelope>[] = [auditMw]
    this.chain = compose(middlewares, (ctx) => this.performFetch(ctx))
  }

  async get(url: string, config?: RunConfig): Promise<AuditResponse> {
    return this.run('GET', url, undefined, config)
  }

  async post(url: string, body?: BodyInit | unknown, config?: RunConfig): Promise<AuditResponse> {
    return this.run('POST', url, body, config)
  }

  async put(url: string, body?: BodyInit | unknown, config?: RunConfig): Promise<AuditResponse> {
    return this.run('PUT', url, body, config)
  }

  async patch(url: string, body?: BodyInit | unknown, config?: RunConfig): Promise<AuditResponse> {
    return this.run('PATCH', url, body, config)
  }

  async delete(url: string, config?: RunConfig): Promise<AuditResponse> {
    return this.run('DELETE', url, undefined, config)
  }

  async close(): Promise<void> {
    if (this.ownsDispatcher && this.dispatcher) {
      await this.dispatcher.close()
    }
  }

  /**
    * Spec §4.2 — the unified request entry used by replay and plugins.
    * Runs the onion middleware chain over a caller-constructed
    * MiddlewareContext. The audit middleware is the outermost link, so a
    * record is produced with the caller's initiator (e.g.
    * `replay:<recordId>`).
    */
  async request(ctx: MiddlewareContext): Promise<AuditResponse> {
    const env = await this.chain(ctx)
    return envelopeToAuditResponse(env)
  }

  private async run(
    method: HttpMethod,
    url: string,
    body: BodyInit | unknown | undefined,
    config?: RunConfig,
  ): Promise<AuditResponse> {
    const headers: Record<string, string> = { ...(config?.headers ?? {}) }
    let bodyStr: string | undefined
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') {
        bodyStr = body
      } else if (body instanceof URLSearchParams) {
        headers['content-type'] ??= 'application/x-www-form-urlencoded'
        bodyStr = body.toString()
      } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        headers['content-type'] ??= 'application/octet-stream'
        bodyStr = bytesToText(body)
      } else {
        // Plain object — JSON stringify.
        headers['content-type'] ??= 'application/json'
        bodyStr = JSON.stringify(body)
      }
    }
    const ctx: MiddlewareContext = {
      method,
      url,
      initiator: config?.initiator ?? 'core',
      headers,
    }
    if (bodyStr !== undefined) ctx.body = bodyStr

    const env = await this.chain(ctx)
    return envelopeToAuditResponse(env)
  }

  /** Terminal handler: undici fetch + body buffering + JSON detection. */
  private async performFetch(ctx: MiddlewareContext): Promise<ResEnvelope> {
    // undici's fetch accepts `dispatcher` on RequestInit (extension);
    // the global RequestInit type doesn't include it. Cast through unknown.
    // We also bridge HeadersInit types between the global lib and undici's
    // bundled types (both extend the standard, but TS sees them as
    // structurally distinct under `exactOptionalPropertyTypes`).
    const init = {
      method: ctx.method,
      headers: ctx.headers,
      ...(ctx.body !== undefined ? { body: ctx.body } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    } as unknown as Parameters<typeof fetch>[1]

    const upstream = await this.fetchImpl(ctx.url, init)
    const resHeaders: Record<string, string> = {}
    upstream.headers.forEach((v, k) => {
      resHeaders[k.toLowerCase()] = v
    })
    if (!upstream.body) {
      return {
        _auditStatus: upstream.status,
        _auditStatusText: upstream.statusText,
        _auditHeaders: resHeaders,
        _auditBodyText: '',
        _auditBodyBytes: 0,
        _auditBodyTruncated: false,
      }
    }

    // Stream body with cap.
    const reader = upstream.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    let truncated = false
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      totalBytes += value.byteLength
      if (totalBytes > MAX_BODY_BYTES) {
        const remaining = MAX_BODY_BYTES - (totalBytes - value.byteLength)
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining))
        }
        truncated = true
        // drain & discard rest
        while (true) {
          const next = await reader.read()
          if (next.done) break
        }
        break
      }
      chunks.push(value)
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8')
    const envelope: ResEnvelope = {
      _auditStatus: upstream.status,
      _auditStatusText: upstream.statusText,
      _auditHeaders: resHeaders,
      _auditBodyText: text,
      _auditBodyBytes: totalBytes,
      _auditBodyTruncated: truncated,
    }
    if (!truncated) {
      const ct = resHeaders['content-type'] ?? ''
      if (ct.includes('json')) {
        try {
          envelope._auditBodyJson = JSON.parse(text)
        } catch {
          // leave undefined; text remains
        }
      }
    }
    return envelope
  }
}

function envelopeToAuditResponse(env: ResEnvelope): AuditResponse {
  const out: AuditResponse = {
    status: env._auditStatus,
    statusText: env._auditStatusText,
    headers: env._auditHeaders,
    bytes: env._auditBodyBytes,
    truncated: env._auditBodyTruncated,
    bodyText: env._auditBodyText,
  }
  if (env._auditBodyJson !== undefined) out.bodyJson = env._auditBodyJson
  return out
}

function bytesToText(body: ArrayBuffer | ArrayBufferView): string {
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString('utf-8')
  }
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf-8')
}