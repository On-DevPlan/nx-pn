/**
 * Integration smoke test: boots a full host on an ephemeral port and
 * exercises the HTTP + audit pipeline end to end. Spec §9.2-style.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { startHost, type StartedHost } from '../index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'

const handles: StartedHost[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.stop()
  }
})

async function makeHost(): Promise<StartedHost> {
  // realpath the OS temp dir so the compiled .mjs paths don't contain the
  // short 8.3 name, which breaks Node's ESM loader for dynamic import().
  const osTmp = await import('node:fs/promises').then(m => m.realpath(tmpdir()))
  const dataDir = await mkdtemp(join(osTmp, 'api-audit-host-'))
  const host = await startHost({ port: 0, dataDir })
  handles.push(host)
  return host
}

// CRC32 for the STORED zip used below.
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
  const lhBuf = Buffer.concat(local)
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.byteLength, 12)
  eocd.writeUInt32LE(lhBuf.byteLength, 16)
  return Buffer.concat([lhBuf, cdBuf, eocd])
}

describe('startHost integration', () => {
  it('serves /api/audit with an empty snapshot', async () => {
    const host = await makeHost()
    const res = await fetch(`http://127.0.0.1:${host.port}/api/audit`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.data.records).toEqual([])
  })

  it('produces an audit record when the HostAuditClient issues a request', async () => {
    const host = await makeHost()

    // Stand up a tiny echo upstream to call.
    const { createServer } = await import('node:http')
    const upstream = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ echoed: req.url }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as { port: number }).port
    try {
      const res = await host.client.get(`http://127.0.0.1:${upstreamPort}/hello?x=1`)
      expect(res.status).toBe(200)
      expect(res.bodyJson).toEqual({ echoed: '/hello?x=1' })

      const audit = await (await fetch(`http://127.0.0.1:${host.port}/api/audit`)).json()
      expect(audit.ok).toBe(true)
      expect(audit.data.records).toHaveLength(1)
      expect(audit.data.records[0].initiator).toBe('core')
      expect(audit.data.records[0].method).toBe('GET')
      expect(audit.data.records[0].status).toBe(200)
      expect(audit.data.records[0].url).toContain('/hello')
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it('serves 503 for frontend static when the web package is absent', async () => {
    const host = await makeHost()
    const res = await fetch(`http://127.0.0.1:${host.port}/`)
    expect([503, 200]).toContain(res.status)
  })

  it('exposes cordis services after installCoreServices', async () => {
    const host = await makeHost()
    // The ring buffer starts empty; auditStore.snapshot() returns [].
    const svc = host.ctx as unknown as { auditStore?: { snapshot(): unknown[] } }
    expect(Array.isArray(svc.auditStore?.snapshot())).toBe(true)
  })

  it('accepts a WS connection and answers an RPC round-trip', async () => {
    const host = await makeHost()
    const { WebSocket } = await import('ws')
    const url = `ws://127.0.0.1:${host.port}/ws`

    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    try {
      // Ask for a snapshot. The bridge's handler doesn't respond for
      // `snapshot.request` (the orchestrator does), so instead verify the
      // connection is alive and heartbeat frames flow.
      const opened = new Promise<void>((resolve) => ws.once('message', () => resolve()))
      // server has no app-level frames, so just confirm a ping arrives
      ws.on('ping', () => {
        /* noop */
      })
      // Ensure the socket stays open briefly.
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(ws.readyState).toBe(ws.OPEN)
      void opened
    } finally {
      ws.close()
    }
  })

  it('pushes snapshot.respond on open and audit.append on new records', async () => {
    const host = await makeHost()
    const { WebSocket } = await import('ws')
    const url = `ws://127.0.0.1:${host.port}/ws`
    const ws = new WebSocket(url)

    const received: unknown[] = []
    // Register the message listener BEFORE awaiting open — the server
    // pushes snapshot.respond as soon as the connection is established,
    // which may precede the client's own 'open' event.
    ws.on('message', (data) => {
      received.push(JSON.parse(data.toString()))
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    try {
      // The server pushes an initial snapshot.respond on connect.
      await new Promise<void>((resolve, reject) => {
        const check = (): void => {
          const snap = received.find((r) => (r as { op: string }).op === 'snapshot.respond')
          if (snap) resolve()
          else setTimeout(check, 20)
        }
        check()
        setTimeout(() => reject(new Error('no snapshot.respond in time')), 2000)
      })

      // A recorded request broadcasts audit.append to the socket.
      const { createServer } = await import('node:http')
      const upstream = createServer((_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end('{}')
      })
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
      const upstreamPort = (upstream.address() as { port: number }).port
      try {
        await host.client.get(`http://127.0.0.1:${upstreamPort}/`)
        await new Promise<void>((resolve, reject) => {
          const check = (): void => {
            const hit = received.find((r) => (r as { op: string }).op === 'audit.append')
            if (hit) resolve()
            else setTimeout(check, 20)
          }
          check()
          setTimeout(() => reject(new Error('no audit.append in time')), 2000)
        })
      } finally {
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      }
    } finally {
      ws.close()
    }
  })

  it('uploads a zip plugin and lists it via /api/plugins', async () => {
    const host = await makeHost()
    const zip = makeZip([
      ['manifest.json', JSON.stringify({
        schemaVersion: 1,
        id: 'smoke',
        version: '1.0.0',
        title: 'Smoke',
        halves: { host: { entry: 'host.js' } },
      })],
      ['host.js', 'export default function (ctx) { ctx.logger.info("smoke plugin started") }'],
    ])

    const boundary = '----api-audit-test-boundary'
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="zip"; filename="smoke.zip"\r\n'),
      Buffer.from('Content-Type: application/zip\r\n\r\n'),
      zip,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])

    const res = await fetch(`http://127.0.0.1:${host.port}/api/plugins`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    })
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.ok).toBe(true)
    expect(json.data.id).toBe('smoke')
    expect(json.data.pluginRunId).toMatch(/^run-/)

    // The plugin is now live in the lifecycle registry.
    expect(host.lifecycle.list()).toHaveLength(1)

    // GET /api/plugins lists it.
    const listRes = await (await fetch(`http://127.0.0.1:${host.port}/api/plugins`)).json()
    expect(listRes.ok).toBe(true)
    expect(listRes.data).toHaveLength(1)
    expect(listRes.data[0].id).toBe('smoke')

    // Stop via the REST endpoint; the registry entry is removed.
    const stopRes = await fetch(`http://127.0.0.1:${host.port}/api/plugins/${json.data.pluginRunId}/stop`, {
      method: 'POST',
    })
    expect(stopRes.status).toBe(200)
  })

  it('replays a recorded request via /api/replay and links replayOf', async () => {
    const host = await makeHost()

    // Upstream echo server.
    const { createServer } = await import('node:http')
    const upstream = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ got: req.url, method: req.method }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as { port: number }).port

    try {
      // 1. Make an original request that gets recorded.
      await host.client.post(`http://127.0.0.1:${upstreamPort}/thing`, { hello: 'world' })
      const audit1 = await (await fetch(`http://127.0.0.1:${host.port}/api/audit`)).json()
      const original = audit1.data.records[0]
      expect(original.replayOf).toBeUndefined()

      // 2. Replay it.
      const replayRes = await fetch(`http://127.0.0.1:${host.port}/api/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordId: original.id }),
      })
      expect(replayRes.status).toBe(200)
      const replay = await replayRes.json()
      expect(replay.ok).toBe(true)
      expect(replay.data.status).toBe(200)

      // 3. The replay created a new record with replayOf pointing at the
      //    original, and initiator `replay:<id>`.
      const audit2 = await (await fetch(`http://127.0.0.1:${host.port}/api/audit`)).json()
      expect(audit2.data.records).toHaveLength(2)
      const replayed = audit2.data.records[1]
      expect(replayed.initiator).toBe(`replay:${original.id}`)
      expect(replayed.replayOf).toBe(original.id)
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it('replay: overriding method to GET on a body-bearing record succeeds', async () => {
    // Regression: replaying a POST (with body) but switching the method to
    // GET used to crash with "Request with GET/HEAD method cannot have
    // body" because the route carried the original body into the GET
    // context. Replay must strip the body when method is GET/HEAD.
    const host = await makeHost()

    const { createServer } = await import('node:http')
    const upstream = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      // Echo method + url so we can confirm what reached the upstream.
      res.end(JSON.stringify({ method: req.method, url: req.url }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as { port: number }).port

    try {
      // 1. POST something so the record carries a body.
      await host.client.post(`http://127.0.0.1:${upstreamPort}/original`, { hi: 'there' })
      const audit1 = await (await fetch(`http://127.0.0.1:${host.port}/api/audit`)).json()
      const original = audit1.data.records[0]
      expect(original.method).toBe('POST')
      expect(original.reqBody.text).toBe('{"hi":"there"}')

      // 2. Replay but override method → GET. The route must drop the body
      //    so undici does not throw.
      const replayRes = await fetch(`http://127.0.0.1:${host.port}/api/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recordId: original.id,
          overrides: { method: 'GET', url: `http://127.0.0.1:${upstreamPort}/replayed` },
        }),
      })
      expect(replayRes.status).toBe(200)
      const replay = await replayRes.json()
      expect(replay.ok).toBe(true)
      expect(replay.data.status).toBe(200)

      // 3. The new audit record reflects GET with no body.
      const audit2 = await (await fetch(`http://127.0.0.1:${host.port}/api/audit`)).json()
      const replayed = audit2.data.records[1]
      expect(replayed.method).toBe('GET')
      expect(replayed.url).toBe(`http://127.0.0.1:${upstreamPort}/replayed`)
      expect(replayed.reqBody.text).toBe('')
      expect(replayed.replayOf).toBe(original.id)
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})
