/**
 * Storage-backed audit persistence (Agent-2 scope):
 *
 *   1. Records persist to the audit domain BEFORE entering the window —
 *      a persist failure drops the record from BOTH (read/write
 *      consistency), and never rejects the business request.
 *   2. Ring buffer: nextId() allocates without inserting; push preserves
 *      a pre-assigned id; rebuild() replays history without onPush.
 *   3. Host restart rebuilds the window from the durable trail with ids
 *      intact and lastId continuing monotonically.
 *   4. /api/replay falls back to the durable domain when the id fell out
 *      of the live window (evicted or pre-restart).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { startHost, type StartedHost } from '../index.js'
import { AuditRingBuffer } from '../client/ring-buffer.js'
import { createAuditMiddleware, type ResEnvelope } from '../client/audit-middleware.js'
import type { AuditRecord } from '../client/audit-record.js'
import type { MiddlewareContext } from '@flowot/nx-pn-core'

const handles: StartedHost[] = []
const upstreams: Server[] = []
const dataDirs: string[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.stop()
  }
  for (const s of upstreams.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
  for (const d of dataDirs.splice(0)) {
    await rm(d, { recursive: true, force: true })
  }
})

async function makeDataDir(): Promise<string> {
  const osTmp = await realpath(tmpdir())
  const dir = await mkdtemp(join(osTmp, 'nx-pn-audit-persist-'))
  dataDirs.push(dir)
  return dir
}

async function makeHost(dataDir: string): Promise<StartedHost> {
  const host = await startHost({ port: 0, dataDir })
  handles.push(host)
  return host
}

async function makeUpstream(): Promise<string> {
  const upstream = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreams.push(upstream)
  const port = (upstream.address() as { port: number }).port
  return `http://127.0.0.1:${port}`
}

// ---------------------------------------------------------------- ring buffer

describe('AuditRingBuffer id/rebuild semantics', () => {
  it('nextId allocates without inserting; push preserves the pre-assigned id', () => {
    const buf = new AuditRingBuffer<{ id: number }>()
    expect(buf.size).toBe(0)
    expect(buf.nextId()).toBe(1)
    expect(buf.size).toBe(0) // allocation alone never enters the window
    const a = buf.push({ id: buf.nextId() })
    expect(a.id).toBe(1)
    const b = buf.push({ id: 0 }) // unassigned → buffer assigns
    expect(b.id).toBe(2)
    expect(buf.lastId).toBe(2)
  })

  it('rebuild inserts history without firing onPush and evicts beyond capacity', () => {
    const pushes: number[] = []
    const buf = new AuditRingBuffer<{ id: number }>({ capacity: 3, onPush: (r) => pushes.push(r.id) })
    buf.rebuild([{ id: 5 }, { id: 3 }, { id: 4 }, { id: 1 }, { id: 2 }])
    expect(pushes).toEqual([]) // rebuild never re-broadcasts history
    expect(buf.snapshot().map((r) => r.id)).toEqual([3, 4, 5]) // sorted, capacity-evicted
    expect(buf.lastId).toBe(5)
    expect(buf.nextId()).toBe(6) // ids continue from the durable maximum
    buf.push({ id: 0 })
    expect(buf.snapshot().map((r) => r.id)).toEqual([4, 5, 6])
    expect(pushes).toEqual([6]) // normal writes still broadcast
  })
})

// ------------------------------------------------------- middleware persist

describe('audit middleware durable-first write path', () => {
  function fakeEnvelope(): ResEnvelope {
    return {
      _auditStatus: 200,
      _auditStatusText: 'OK',
      _auditHeaders: {},
      _auditBodyText: '',
      _auditBodyBytes: 0,
      _auditBodyTruncated: false,
    }
  }

  it('persists BEFORE push — the buffer receives the record with the persisted id', async () => {
    const buf = new AuditRingBuffer<AuditRecord>()
    const persisted: number[] = []
    const mw = createAuditMiddleware({
      buffer: buf,
      persist: async (record) => {
        persisted.push(record.id)
      },
    })
    const ctx: MiddlewareContext = { method: 'GET', url: 'https://x/1', initiator: 'core', headers: {} }
    await mw(ctx, async () => fakeEnvelope())
    expect(persisted).toEqual([1])
    expect(buf.snapshot().map((r) => r.id)).toEqual([1])
  })

  it('a persist failure drops the record from BOTH the medium and the window, without throwing', async () => {
    const buf = new AuditRingBuffer<AuditRecord>()
    let failNext = true
    const mw = createAuditMiddleware({
      buffer: buf,
      persist: async () => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
      },
    })
    const ctx: MiddlewareContext = { method: 'GET', url: 'https://x/1', initiator: 'core', headers: {} }
    await expect(mw(ctx, async () => fakeEnvelope())).resolves.toBeDefined()
    expect(buf.snapshot()).toEqual([]) // failed persist → neither medium nor window

    // The failed id is NOT consumed — the next successful record takes id 1.
    const ctx2: MiddlewareContext = { method: 'GET', url: 'https://x/2', initiator: 'core', headers: {} }
    await mw(ctx2, async () => fakeEnvelope())
    expect(buf.snapshot().map((r) => r.id)).toEqual([1])
  })
})

// ------------------------------------------------------- restart persistence

describe('audit domain restart persistence', () => {
  it('rebuilds the window from the durable trail; ids and lastId survive the restart', async () => {
    const dataDir = await makeDataDir()
    const base = await makeUpstream()

    const hostA = await makeHost(dataDir)
    await hostA.client.get(`${base}/one`)
    await hostA.client.get(`${base}/two`)
    const idsA = hostA.buffer.snapshot().map((r) => r.id)
    expect(idsA).toEqual([1, 2])
    await hostA.stop()
    handles.splice(handles.indexOf(hostA), 1)

    const hostB = await makeHost(dataDir)
    // Same records, same ids, same order — the durable trail IS the source.
    expect(hostB.buffer.snapshot().map((r) => r.id)).toEqual([1, 2])
    expect(hostB.buffer.snapshot().map((r) => r.url)).toEqual([`${base}/one`, `${base}/two`])
    expect(hostB.buffer.lastId).toBe(2)
    // New writes continue monotonically after the rebuilt maximum.
    await hostB.client.get(`${base}/three`)
    expect(hostB.buffer.lastId).toBe(3)
  })

  it('evicted-window records still replay via the durable-domain fallback', async () => {
    const dataDir = await makeDataDir()
    const base = await makeUpstream()

    // Write 55 records against the default capacity-50 window: ids 1..5
    // fall out of the window but stay in the durable domain.
    const hostA = await makeHost(dataDir)
    for (let i = 1; i <= 55; i++) {
      await hostA.client.get(`${base}/bulk-${i}`)
    }
    expect(hostA.buffer.lastId).toBe(55)
    expect(hostA.buffer.get(3)).toBeUndefined() // evicted from the window
    expect(hostA.auditDomain.table('records').get('3')).toBeDefined() // still durable
    await hostA.stop()
    handles.splice(handles.indexOf(hostA), 1)

    const hostB = await makeHost(dataDir)
    // Window rebuilt to its capacity from the durable trail.
    expect(hostB.buffer.lastId).toBe(55)
    expect(hostB.buffer.get(3)).toBeUndefined()

    // Replay an evicted record: window miss → durable fallback → 200.
    const replayRes = await fetch(`http://127.0.0.1:${hostB.port}/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recordId: 3 }),
    })
    expect(replayRes.status).toBe(200)
    const replayJson = (await replayRes.json()) as { ok: boolean; data: { status: number } }
    expect(replayJson.ok).toBe(true)
    expect(replayJson.data.status).toBe(200)

    // A record that exists nowhere answers 404.
    const missingRes = await fetch(`http://127.0.0.1:${hostB.port}/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recordId: 9999 }),
    })
    expect(missingRes.status).toBe(404)
  }, 30000)
})
