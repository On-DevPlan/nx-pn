/**
 * Hot-add E2E — the full plugin loop, live (spec §7, §9.2).
 *
 *   1. startHost on an ephemeral port
 *   2. build the REAL plugins/example-api zip in-memory (esbuild from
 *      the plugin source — host half + browser half + manifest)
 *   3. upload it over the REST pipeline (POST /api/plugins multipart)
 *   4. assert lifecycle registration + parsed manifest
 *   5. trigger the plugin's tool endpoint (cordis event) → assert an
 *      AuditRecord with initiator === 'example-api' lands in the ring
 *      buffer — plugin network IO goes through the core unified client
 *      and is attributed (spec §7.4)
 *   6. evaluate the compiled browser half with a fake ctx → assert its
 *      `ctx.pages.register` contract is honoured (path/title/pluginId)
 *   7. stop → fiber disposed, event listener gone; remove → registry
 *      entry gone
 *   8. re-upload (version-update simulation) → new pluginRunId, old
 *      entry cleaned up, tool still works
 *
 * This is the acceptance test for "core provides the unified Client,
 * plugin IO goes through it, hot-add works".
 */

import { describe, it, expect, afterEach } from 'vitest'
import { build } from 'esbuild'
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { startHost, type StartedHost } from '../index.js'
import { importCompiledModule } from '../plugins/host-compiler.js'

const PLUGIN_DIR = fileURLToPath(new URL('../../../../plugins/example-api/', import.meta.url))
// The compiled browser half imports `react`, `react/jsx-runtime`, and
// `react-router-dom` as bare specifiers (spec §5.2.2 — they must NOT be
// bundled, the app resolves them via its import map). To evaluate that
// module in Node, the temp file must sit in a directory whose
// node_modules walk-up finds the real React stack — `apps/web/` carries
// them via pnpm hoisting, so we write the temp file under there.
const EVAL_DIR = join(PLUGIN_DIR, '..', '..', 'apps', 'web', '.tmp-browser-half-eval')

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
    res.end(JSON.stringify({ echoed: req.url, via: 'example-api-e2e' }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreams.push(upstream)
  const port = (upstream.address() as { port: number }).port
  return `http://127.0.0.1:${port}`
}

/** Compile both halves of the real plugin source (mirrors
 *  plugins/example-api/scripts/build-zip.mjs). */
async function compilePluginHalves(): Promise<{ hostJs: string; browserJs: string }> {
  const hostJs = await build({
    entryPoints: [join(PLUGIN_DIR, 'host.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['cordis'],
    write: false,
    logLevel: 'silent',
  }).then((r) => r.outputFiles![0]!.text)

  const browserJs = await build({
    entryPoints: [join(PLUGIN_DIR, 'browser.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'cordis'],
    write: false,
    logLevel: 'silent',
  }).then((r) => r.outputFiles![0]!.text)

  return { hostJs, browserJs }
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

async function buildExampleZip(): Promise<Buffer> {
  const { hostJs, browserJs } = await compilePluginHalves()
  const manifest = await readFileText('manifest.json')
  return makeZip([
    ['manifest.json', manifest],
    ['host.js', hostJs],
    ['browser.js', browserJs],
  ])
}

function readFileText(name: string): Promise<string> {
  return import('node:fs/promises').then((m) => m.readFile(join(PLUGIN_DIR, name), 'utf-8'))
}

/** Upload a zip over the real REST pipeline; returns the 201 payload. */
async function uploadViaRest(host: StartedHost, zip: Buffer): Promise<{ id: string; pluginRunId: string; manifest: { id: string; halves: { browser?: { entry: string } } } }> {
  const boundary = '----api-audit-hotadd-boundary'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="zip"; filename="example-api.zip"\r\n'),
    Buffer.from('Content-Type: application/zip\r\n\r\n'),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const res = await fetch(`http://127.0.0.1:${host.port}/api/plugins`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
  const json = (await res.json()) as { ok: boolean; data: { id: string; pluginRunId: string; manifest: { id: string; halves: { browser?: { entry: string } } } } }
  expect(res.status).toBe(201)
  expect(json.ok).toBe(true)
  return json.data
}

/** Poll until `pred` is true or the timeout elapses. */
async function waitFor<T>(pred: () => T | undefined, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = pred()
    if (hit !== undefined) return hit
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('hot-add e2e — example-api plugin (spec §7 / §9.2)', () => {
  it('uploads the real plugin zip, attributes its IO, proves the browser-half contract, stops, and re-uploads', async () => {
    const host = await makeHost()
    const upstreamBase = await makeEchoUpstream()
    const zip = await buildExampleZip()

    // ── 1. hot-add over REST ────────────────────────────────────────
    const first = await uploadViaRest(host, zip)
    expect(first.id).toBe('example-api')
    expect(first.pluginRunId).toMatch(/^run-/)

    // Lifecycle registry entry + parsed manifest.
    const entry = host.lifecycle.byRunId(first.pluginRunId)
    expect(entry).toBeDefined()
    expect(entry!.id).toBe('example-api')
    expect(entry!.manifest.id).toBe('example-api')
    expect(entry!.manifest.halves.host?.entry).toBe('host.js')
    expect(entry!.manifest.halves.browser?.entry).toBe('browser.js')
    expect(entry!.fiber.state).toBe(2) // FiberState.ACTIVE

    // ── 2. trigger the plugin tool → attributed audit record ───────
    const toolUrl = `${upstreamBase}/hot-add?proof=1`
    host.ctx.emit('example-api/fetch', { url: toolUrl })

    const record = await waitFor(() => {
      return host.buffer
        .snapshot()
        .find((r) => r.initiator === 'example-api' && r.url === toolUrl)
    }, 5000, 'attributed audit record')

    expect(record.status).toBe(200)
    expect(record.method).toBe('GET')
    expect(record.resBody.json).toEqual({ echoed: '/hot-add?proof=1', via: 'example-api-e2e' })

    // ── 3. browser half: pages.register contract honoured ──────────
    const { browserJs } = await compilePluginHalves()
    await mkdir(EVAL_DIR, { recursive: true })
    const evalDir = await mkdtemp(join(EVAL_DIR, 'run-'))
    const tmpMod = join(evalDir, 'browser-half.mjs')
    await writeFile(tmpMod, browserJs, 'utf-8')
    const mod = await importCompiledModule(tmpMod)
    const registered: Array<{ pluginId?: string; path?: string; title?: string; order?: number }> = []
    const fakeCtx = {
      logger: { info: () => {} },
      pages: { register: (e: { pluginId?: string; path?: string; title?: string; order?: number }): void => { registered.push(e) } },
    }
    ;(mod.default as (ctx: unknown) => void)(fakeCtx)
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({
      pluginId: 'example-api',
      path: '/example-api',
      title: '示例 API',
      order: 200,
    })
    await rm(evalDir, { recursive: true, force: true })

    // ── 4. stop → fiber disposed, tool dead; remove → gone ─────────
    const stopRes = await fetch(`http://127.0.0.1:${host.port}/api/plugins/${first.pluginRunId}/stop`, { method: 'POST' })
    expect(stopRes.status).toBe(200)
    const stoppedEntry = host.lifecycle.byRunId(first.pluginRunId)
    expect(stoppedEntry).toBeDefined() // stop keeps the entry (lifecycle semantics)
    expect(stoppedEntry!.fiber.state).toBe(4) // FiberState.DISPOSED

    const countAfterStop = host.buffer.snapshot().filter((r) => r.url === toolUrl).length
    host.ctx.emit('example-api/fetch', { url: `${toolUrl}&dead=1` })
    await new Promise((resolve) => setTimeout(resolve, 150))
    // The disposed fiber's listener is gone — no new attributed records.
    expect(host.buffer.snapshot().filter((r) => r.url.startsWith(toolUrl)).length).toBe(countAfterStop)

    const removeRes = await fetch(`http://127.0.0.1:${host.port}/api/plugins/${first.pluginRunId}/remove`, { method: 'POST' })
    expect(removeRes.status).toBe(200)
    expect(host.lifecycle.byRunId(first.pluginRunId)).toBeUndefined()
    expect(host.lifecycle.list()).toHaveLength(0)

    // ── 5. re-upload (version update) → fresh run id, tool alive ───
    const second = await uploadViaRest(host, zip)
    expect(second.pluginRunId).not.toBe(first.pluginRunId)
    expect(host.lifecycle.list()).toHaveLength(1)
    expect(host.lifecycle.byRunId(second.pluginRunId)).toBeDefined()

    const toolUrl2 = `${upstreamBase}/hot-add-v2`
    host.ctx.emit('example-api/fetch', { url: toolUrl2 })
    const record2 = await waitFor(() => {
      return host.buffer
        .snapshot()
        .find((r) => r.initiator === 'example-api' && r.url === toolUrl2)
    }, 5000, 'attributed record after re-upload')
    expect(record2.status).toBe(200)
  }, 20000)
})
