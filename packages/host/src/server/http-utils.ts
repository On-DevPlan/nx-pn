/**
 * HTTP request body reader with a size cap. Used by all routes that
 * consume bodies (upload, replay).
 */

import type { IncomingMessage } from 'node:http'

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`body exceeds limit (${limit} bytes)`)
  }
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += c.byteLength
    if (total > maxBytes) throw new BodyTooLargeError(maxBytes)
    chunks.push(c)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf-8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += c.byteLength
    if (total > maxBytes) throw new BodyTooLargeError(maxBytes)
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

export function sendJson(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

export function sendText(res: import('node:http').ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.statusCode = status
  res.setHeader('content-type', contentType)
  res.end(body)
}