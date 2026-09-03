/**
 * POST /api/plugins — multipart zip upload → load pipeline (spec §4.4.1).
 *
 * We intentionally use a hand-rolled multipart parser that handles the
 * single 'zip' field; the host has zero npm deps for HTTP, so pulling
 * in busboy would add a sizeable dependency for one route.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendText } from './http-utils.js'
import type { PluginLoader } from '../plugins/loader.js'
import { LoaderError } from '../plugins/loader.js'

export function handleUploadPlugin(deps: { loader: PluginLoader }, req: IncomingMessage, res: ServerResponse): void {
  const ctype = (req.headers['content-type'] ?? '').toString()
  const m = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!m) {
    sendJson(res, 400, { ok: false, error: { code: 'upload/no-boundary', message: 'multipart/form-data boundary missing' } })
    return
  }
  const boundary = `--${m[1] ?? m[2]}`

  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    void onEnd(Buffer.concat(chunks))
  })
  req.on('error', (err) => {
    sendJson(res, 500, { ok: false, error: { code: 'upload/stream-error', message: err.message } })
  })

  async function onEnd(body: Buffer): Promise<void> {
    try {
      const zipBytes = parseMultipartZip(body, boundary)
      if (!zipBytes) {
        sendJson(res, 400, { ok: false, error: { code: 'upload/no-zip-field', message: 'no zip field found' } })
        return
      }
      const result = await deps.loader.load({ zipBytes })
      sendJson(res, 201, {
        ok: true,
        data: {
          id: result.id,
          pluginRunId: result.pluginRunId,
          manifest: result.manifest,
        },
      })
    } catch (err) {
      if (err instanceof LoaderError) {
        const status =
          err.code.startsWith('zip/') || err.code.startsWith('manifest/') ? 400 :
          err.code === 'compile/no-export' || err.code === 'compile/import-failed' ? 422 :
          500
        sendJson(res, status, { ok: false, error: { code: err.code, message: err.message } })
        return
      }
      sendText(res, 500, (err as Error).message)
    }
  }
}

/** Naive multipart parser: returns the bytes of the first file field. */
function parseMultipartZip(body: Buffer, boundary: string): Uint8Array | null {
  const boundaryBuf = Buffer.from(boundary)
  let pos = 0
  while (pos < body.byteLength) {
    const start = body.indexOf(boundaryBuf, pos)
    if (start < 0) return null
    pos = start + boundaryBuf.byteLength
    const next = body.indexOf(boundaryBuf, pos)
    if (next < 0) return null
    const part = body.subarray(pos, next)
    // Strip trailing \r\n before boundary
    let end = part.byteLength
    if (end >= 2 && part[end - 2] === 0x0d && part[end - 1] === 0x0a) end -= 2
    const slice = part.subarray(0, end)

    // Find headers/body split
    const headerEnd = slice.indexOf('\r\n\r\n')
    if (headerEnd < 0) continue
    const headerText = slice.subarray(0, headerEnd).toString('utf-8')
    if (!/filename=/i.test(headerText)) continue
    if (!/name="zip"/i.test(headerText)) continue
    return new Uint8Array(slice.subarray(headerEnd + 4))
  }
  return null
}