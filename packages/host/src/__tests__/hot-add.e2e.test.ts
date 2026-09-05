/**
 * Hot-add E2E — the full plugin loop, live (spec §7, §9.2).
 *
 * Rewritten to build a minimal in-memory plugin (no external plugin source
 * required) so it survives plugin directory deletions.
 *
 *   1. startHost on an ephemeral port
 *   2. write a TINY plugin (host.js + browser.js + manifest) to a temp dir
 *   3. zip it up using our in-process zip writer
 *   4. upload it over the REST pipeline (POST /api/plugins multipart)
 *   5. assert lifecycle registration + parsed manifest
 *   6. trigger the plugin's tool endpoint (cordis event) → assert an
 *      AuditRecord with initiator === 'tiny-hotadd' lands in the ring buffer
 *   7. evaluate the compiled browser half with a fake ctx → assert its
 *      `ctx.pages.register` contract is honoured (path/title/pluginId)
 *   8. stop → fiber disposed, event listener gone; remove → registry entry gone
 *   9. re-upload (version-update simulation) → new pluginRunId, old entry
 *      cleaned up, tool still works
 */

import { describe, it, expect, afterEach } from 'vitest'
import { build } from 'esbuild'
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { createServer, type Server } from 'node:http'
import { startHost, type StartedHost } from '../index.js'
import { importCompiledModule } from '../plugins/host-compiler.js'

const handles: StartedHost[] = []
const upstreams: Server[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.stop()
  }
  for (const s of upstreams.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

async function makeHost(): Promise<StartedHost> {
  const osTmp = await realpath(tmpdir())
  const dataDir = await mkdtemp(join(osTmp, 'api-audit-hotadd-'))
  const host = await startHost({ port: 0, dataDir })
  handles.push(host)
  return host
}

async function makeEchoUpstream(): Promise<string> {
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ echoed: req.url, via: 'tiny-hotadd-e2e' }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreams.push(upstream)
  const port = (upstream.address() as { port: number }).port
  return `http://127.0.0.1:${port}`
}

// CRC32 for the STORED zip writer.
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.byteLength; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(parts: Array<[string, Buffer | string]>): Buffer {
  const entries = parts.map(([name, data]) => ({
    name,
    data: typeof data === 'string' ? Buffer.from(data, 'utf-8') : data,
  }))
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8')
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0, 8)
    lfh.writeUInt32LE(crc32(e.data), 14)
    lfh.writeUInt32LE(e.data.byteLength, 18)
    lfh.writeUInt32LE(e.data.byteLength, 22)
    lfh.writeUInt16LE(nameBuf.byteLength, 26)
    local.push(lfh, nameBuf, e.data)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt32LE(crc32(e.data), 16)
    cdh.writeUInt32LE(e.data.byteLength, 20)
    cdh.writeUInt32LE(e.data.byteLength, 24)
    cdh.writeUInt16LE(nameBuf.byteLength, 28)
    cdh.writeUInt32LE(offset, 42)
    central.push(cdh, nameBuf)
    offset += 30 + nameBuf.byteLength + e.data.byteLength
  }
  const localBuf = Buffer.concat(local)
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.byteLength, 12)
  eocd.writeUInt32LE(localBuf.byteLength, 16)
  return Buffer.concat([localBuf, cdBuf, eocd])
}

/** Build a tiny in-memory plugin and return it as a zip Buffer.
 *
 * We write the plugin source to a real temp dir so esbuild can process it
 * as a proper file entry point. The temp dir is discarded after the zip is
 * assembled.
 */
async function buildTinyPluginZip(upstreamBase: string): Promise<Buffer> {
  const osTmp = await realpath(tmpdir())
  const srcDir = await mkdtemp(join(osTmp, 'tiny-plugin-src-'))

  try {
    // Write raw plugin sources to temp files
    const hostSrcPath = join(srcDir, 'host.ts')
    const browserSrcPath = join(srcDir, 'browser.tsx')

    await writeFile(
      hostSrcPath,
      [
        `const plugin = function (ctx) {`,
        `  ctx.on('tiny-hotadd/probe', async (payload) => {`,
        `    const url = (payload && typeof payload.url === 'string')`,
        `      ? payload.url`,
        `      : '${upstreamBase}/default'`,
        `    return await ctx.auditClient.get(url)`,
        `  })`,
        `}`,
        `plugin.inject = ['auditClient']`,
        `export default plugin`,
      ].join('\n'),
      'utf-8',
    )

    await writeFile(
      browserSrcPath,
      [
        `const plugin = function (ctx) {`,
        `  ctx.pages.register({`,
        `    pluginId: 'tiny-hotadd',`,
        `    path: '/tiny-hotadd',`,
        `    title: 'Tiny HotAdd',`,
        `    order: 300,`,
        `  })`,
        `}`,
        `export default plugin`,
      ].join('\n'),
      'utf-8',
    )

    const manifest = JSON.stringify({
      schemaVersion: 1,
      id: 'tiny-hotadd',
      version: '0.1.0',
      title: 'Tiny HotAdd',
      halves: {
        host: { entry: 'host.js' },
        browser: { entry: 'browser.js' },
      },
    })

    const hostJs = await build({
      entryPoints: [hostSrcPath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['cordis'],
      outdir: srcDir,
      write: true,
      logLevel: 'silent',
    }).then(() =>
      import('node:fs/promises').then((m) => m.readFile(join(srcDir, 'host.js'), 'utf-8')),
    )

    const browserJs = await build({
      entryPoints: [browserSrcPath],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'cordis'],
      outdir: srcDir,
      write: true,
      logLevel: 'silent',
    }).then(() =>
      import('node:fs/promises').then((m) => m.readFile(join(srcDir, 'browser.js'), 'utf-8')),
    )

    return makeZip([
      ['manifest.json', manifest],
      ['host.js', hostJs],
      ['browser.js', browserJs],
    ])
  } finally {
    await rm(srcDir, { recursive: true, force: true })
  }
}

/** Upload a zip over the real REST pipeline; returns the 201 payload. */
async function uploadViaRest(
  host: StartedHost,
  zip: Buffer,
): Promise<{
  id: string
  pluginRunId: string
  manifest: { id: string; halves: { browser?: { entry: string } } }
}> {
  const boundary = '----tiny-hotadd-boundary'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="zip"; filename="tiny-hotadd.zip"\r\n'),
    Buffer.from('Content-Type: application/zip\r\n\r\n'),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const res = await fetch(`http://127.0.0.1:${host.port}/api/plugins`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
  const text = await res.text()
  let json: { ok: boolean; data?: { id: string; pluginRunId: string; manifest: { id: string; halves: { browser?: { entry: string } } } }; error?: { code: string; message: string } }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Server returned non-JSON (${res.status}): ${text.slice(0, 500)}`)
  }
  if (!json.ok) {
    throw new Error(`Server rejected upload: ${json.error?.code} — ${json.error?.message}`)
  }
  expect(res.status).toBe(201)
  return json.data!
}

/** Poll until `pred` is true or the timeout elapses. */
async function waitFor<T>(
  pred: () => T | undefined,
  timeoutMs = 5000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = pred()
    if (hit !== undefined) return hit
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Directory under apps/web/.tmp-browser-half-eval for browser-half evaluation.
// It needs to be under a directory whose node_modules walk-up finds react.
const EVAL_PARENT = join(process.cwd(), 'apps', 'web', '.tmp-browser-half-eval')

describe('hot-add e2e — in-memory tiny plugin (spec §7 / §9.2)', () => {
  it(
    'uploads the in-memory plugin zip, attributes its IO, proves the browser-half contract, stops, and re-uploads',
    async () => {
      const host = await makeHost()
      const upstreamBase = await makeEchoUpstream()
      const zip = await buildTinyPluginZip(upstreamBase)

      // ── 1. hot-add over REST ────────────────────────────────────────
      const first = await uploadViaRest(host, zip)
      expect(first.id).toBe('tiny-hotadd')
      expect(first.pluginRunId).toMatch(/^run-/)

      // Lifecycle registry entry + parsed manifest.
      const entry = host.lifecycle.byRunId(first.pluginRunId)
      expect(entry).toBeDefined()
      expect(entry!.id).toBe('tiny-hotadd')
      expect(entry!.manifest.id).toBe('tiny-hotadd')
      expect(entry!.manifest.halves.host?.entry).toBe('host.js')
      expect(entry!.manifest.halves.browser?.entry).toBe('browser.js')
      expect(entry!.fiber.state).toBe(2) // FiberState.ACTIVE

      // ── 2. trigger the plugin tool → attributed audit record ───────
      const toolUrl = `${upstreamBase}/hot-add?proof=1`
      host.ctx.emit('tiny-hotadd/probe', { url: toolUrl })

      const record = await waitFor(
        () =>
          host.buffer.snapshot().find((r) => r.initiator === 'tiny-hotadd' && r.url === toolUrl),
        5000,
        'attributed audit record',
      )

      expect(record.status).toBe(200)
      expect(record.method).toBe('GET')
      expect(record.resBody.json).toEqual({ echoed: '/hot-add?proof=1', via: 'tiny-hotadd-e2e' })

      // ── 3. browser half: pages.register contract honoured ──────────
      // Build browser.js to a temp dir, then evaluate it
      const osTmp = await realpath(tmpdir())
      const browserSrcDir = await mkdtemp(join(osTmp, 'browser-half-src-'))
      await writeFile(
        join(browserSrcDir, 'browser.tsx'),
        [
          `const plugin = function (ctx) {`,
          `  ctx.pages.register({`,
          `    pluginId: 'tiny-hotadd',`,
          `    path: '/tiny-hotadd',`,
          `    title: 'Tiny HotAdd',`,
          `    order: 300,`,
          `  })`,
          `}`,
          `export default plugin`,
        ].join('\n'),
        'utf-8',
      )
      const browserOutDir = await mkdtemp(join(browserSrcDir, 'out-'))
      await build({
        entryPoints: [join(browserSrcDir, 'browser.tsx')],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        jsx: 'automatic',
        external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'cordis'],
        outdir: browserOutDir,
        write: true,
        logLevel: 'silent',
      })

      await mkdir(EVAL_PARENT, { recursive: true })
      const evalDir = await mkdtemp(join(EVAL_PARENT, 'run-'))
      const tmpMod = join(evalDir, 'browser-half.mjs')
      await writeFile(tmpMod, await import('node:fs/promises').then((m) => m.readFile(join(browserOutDir, 'browser.js'), 'utf-8')), 'utf-8')
      const mod = await importCompiledModule(tmpMod)
      const registered: Array<{
        pluginId?: string
        path?: string
        title?: string
        order?: number
      }> = []
      const fakeCtx = {
        logger: { info: () => {} },
        pages: {
          register: (e: {
            pluginId?: string
            path?: string
            title?: string
            order?: number
          }): void => {
            registered.push(e)
          },
        },
      }
      ;(mod.default as (ctx: unknown) => void)(fakeCtx)
      expect(registered).toHaveLength(1)
      expect(registered[0]).toMatchObject({
        pluginId: 'tiny-hotadd',
        path: '/tiny-hotadd',
        title: 'Tiny HotAdd',
        order: 300,
      })
      await rm(evalDir, { recursive: true, force: true })
      await rm(browserSrcDir, { recursive: true, force: true })

      // ── 4. stop → fiber disposed, tool dead; remove → gone ─────────
      const stopRes = await fetch(
        `http://127.0.0.1:${host.port}/api/plugins/${first.pluginRunId}/stop`,
        { method: 'POST' },
      )
      expect(stopRes.status).toBe(200)
      const stoppedEntry = host.lifecycle.byRunId(first.pluginRunId)
      expect(stoppedEntry).toBeDefined() // stop keeps the entry (lifecycle semantics)
      expect(stoppedEntry!.fiber.state).toBe(4) // FiberState.DISPOSED

      const countAfterStop = host.buffer.snapshot().filter((r) => r.url === toolUrl).length
      host.ctx.emit('tiny-hotadd/probe', { url: `${toolUrl}&dead=1` })
      await new Promise((resolve) => setTimeout(resolve, 150))
      // The disposed fiber's listener is gone — no new attributed records.
      expect(
        host.buffer.snapshot().filter((r) => r.url.startsWith(toolUrl)).length,
      ).toBe(countAfterStop)

      const removeRes = await fetch(
        `http://127.0.0.1:${host.port}/api/plugins/${first.pluginRunId}/remove`,
        { method: 'POST' },
      )
      expect(removeRes.status).toBe(200)
      expect(host.lifecycle.byRunId(first.pluginRunId)).toBeUndefined()
      expect(host.lifecycle.list()).toHaveLength(0)

      // ── 5. re-upload (version update) → fresh run id, tool alive ───
      const second = await uploadViaRest(host, zip)
      expect(second.pluginRunId).not.toBe(first.pluginRunId)
      expect(host.lifecycle.list()).toHaveLength(1)
      expect(host.lifecycle.byRunId(second.pluginRunId)).toBeDefined()

      const toolUrl2 = `${upstreamBase}/hot-add-v2`
      host.ctx.emit('tiny-hotadd/probe', { url: toolUrl2 })
      const record2 = await waitFor(
        () =>
          host.buffer
            .snapshot()
            .find((r) => r.initiator === 'tiny-hotadd' && r.url === toolUrl2),
        5000,
        'attributed record after re-upload',
      )
      expect(record2.status).toBe(200)
    },
    20000,
  )
})
