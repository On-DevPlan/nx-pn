import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PluginLoader } from '../plugins/loader.js'
import { PluginLifecycle } from '../plugins/lifecycle.js'
import { CordisContext, type Context } from '../cordis/cordis-shim.js'
import { rm } from 'node:fs/promises'

function makeZip(parts: Array<[string, Buffer | string]>): Uint8Array {
  // Minimal STORED-only zip writer for tests.
  const entries = parts.map(([name, data]) => ({
    name,
    data: typeof data === 'string' ? Buffer.from(data, 'utf-8') : data,
  }))
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8')
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0, 6) // flags
    lfh.writeUInt16LE(0, 8) // method (stored)
    lfh.writeUInt16LE(0, 10) // mod time
    lfh.writeUInt16LE(0, 12) // mod date
    lfh.writeUInt32LE(crc32(e.data), 14)
    lfh.writeUInt32LE(e.data.byteLength, 18) // comp size
    lfh.writeUInt32LE(e.data.byteLength, 22) // uncomp size
    lfh.writeUInt16LE(nameBuf.byteLength, 26)
    lfh.writeUInt16LE(0, 28) // extra len
    localParts.push(lfh, nameBuf, e.data)
    // central directory entry
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4) // version made by
    cdh.writeUInt16LE(20, 6) // version needed
    cdh.writeUInt16LE(0, 8)
    cdh.writeUInt16LE(0, 10)
    cdh.writeUInt16LE(0, 12)
    cdh.writeUInt16LE(0, 14)
    cdh.writeUInt32LE(crc32(e.data), 16)
    cdh.writeUInt32LE(e.data.byteLength, 20)
    cdh.writeUInt32LE(e.data.byteLength, 24)
    cdh.writeUInt16LE(nameBuf.byteLength, 28)
    cdh.writeUInt16LE(0, 30)
    cdh.writeUInt16LE(0, 32)
    cdh.writeUInt16LE(0, 34) // disk number
    cdh.writeUInt16LE(0, 36) // internal attrs
    cdh.writeUInt32LE(0, 38) // external attrs
    cdh.writeUInt32LE(offset, 42)
    centralParts.push(cdh, nameBuf)
    offset += 30 + nameBuf.byteLength + e.data.byteLength
  }
  const lhBuf = Buffer.concat(localParts)
  const cdBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.byteLength, 12)
  eocd.writeUInt32LE(lhBuf.byteLength, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([lhBuf, cdBuf, eocd])
}

// CRC32 implementation (used by zip writer for STORED entries)
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.byteLength; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

function manifestJson(id: string) {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    version: '1.0.0',
    title: id,
    halves: { host: { entry: 'host.js' } },
  })
}

describe('PluginLoader', () => {
  let dataDir: string
  let ctx: Context
  let lifecycle: PluginLifecycle
  let loader: PluginLoader

  beforeEach(async () => {
    dataDir = await PluginLoader.ensureTmpDataDir()
    ctx = new CordisContext()
    lifecycle = new PluginLifecycle()
    loader = new PluginLoader({ dataDir, ctx, lifecycle })
  })

  afterEach(async () => {
    await lifecycle.stopAll()
    try {
      await rm(dataDir, { recursive: true })
    } catch {
      // ignore
    }
  })

  it('happy path: loads a valid host half', async () => {
    const src = 'export default function (ctx) { ctx.logger.info("hello from plugin") }'
    const zip = makeZip([
      ['manifest.json', manifestJson('myplug')],
      ['host.js', src],
    ])
    const result = await loader.load({ zipBytes: zip })
    expect(result.id).toBe('myplug')
    expect(result.pluginRunId).toMatch(/^run-/)
    expect(result.manifest.id).toBe('myplug')
    expect(lifecycle.list()).toHaveLength(1)
    // The registered fiber must be ACTIVE (activation completed).
    const entry = lifecycle.byRunId(result.pluginRunId)
    expect(entry).toBeDefined()
    // fiber.state === FiberState.ACTIVE (2)
    expect(entry!.fiber.state).toBe(2)
    // A registered plugin can be stopped via dispose.
    await lifecycle.stop(result.pluginRunId)
  })

  it('rejects invalid manifest', async () => {
    const zip = makeZip([
      ['manifest.json', JSON.stringify({ schemaVersion: 99 })],
      ['host.js', 'export default () => {}'],
    ])
    await expect(loader.load({ zipBytes: zip })).rejects.toThrow(/Invalid manifest/)
  })

  it('rejects missing manifest.json', async () => {
    const zip = makeZip([['host.js', 'export default () => {}']])
    await expect(loader.load({ zipBytes: zip })).rejects.toThrow(/manifest\.json/)
  })

  it('rejects manifest without host entry', async () => {
    const zip = makeZip([
      ['manifest.json', JSON.stringify({
        schemaVersion: 1,
        id: 'x',
        version: '1.0.0',
        title: 'X',
        halves: { browser: { entry: 'b.js' } },
      })],
      ['host.js', 'export default () => {}'],
    ])
    await expect(loader.load({ zipBytes: zip })).rejects.toThrow(/host.*entry/)
  })

  it('rejects zip too large', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0)
    await expect(loader.load({ zipBytes: big })).rejects.toThrow(/exceeds/)
  })

  it('runtime error during plugin apply is reported', async () => {
    const src = 'export default function () { throw new Error("boom") }'
    const zip = makeZip([
      ['manifest.json', manifestJson('crash')],
      ['host.js', src],
    ])
    await expect(loader.load({ zipBytes: zip })).rejects.toThrow()
  })

  it('re-upload dedup: same manifest.id replaces the old run', async () => {
    // Side effect the test half sets a global flag when its fiber is
    // disposed — that proves the OLD fiber's effects (including any
    // ctx.effect disposers) actually ran on the lifecycle.remove() call
    // the loader does before registering the new run.
    const g = globalThis as unknown as { __dedupHalfDisped?: number }
    g.__dedupHalfDisped = 0
    const half = `export default function (ctx) {
      ctx.effect(() => () => { globalThis.__dedupHalfDisped = (globalThis.__dedupHalfDisped || 0) + 1 })
    }`

    const zip = makeZip([
      ['manifest.json', manifestJson('dedup')],
      ['host.js', half],
    ])

    // First upload.
    const first = await loader.load({ zipBytes: zip })
    expect(first.id).toBe('dedup')
    expect(first.replaced).toEqual([])
    expect(lifecycle.list()).toHaveLength(1)
    const firstEntry = lifecycle.byRunId(first.pluginRunId)
    expect(firstEntry).toBeDefined()
    const firstFiber = firstEntry!.fiber

    // Second upload with the same id → the old run is evicted.
    const second = await loader.load({ zipBytes: zip })
    expect(second.id).toBe('dedup')
    expect(second.pluginRunId).not.toBe(first.pluginRunId)
    expect(second.replaced).toEqual([first.pluginRunId])
    // Exactly ONE entry for this id is alive — the new run.
    expect(lifecycle.list()).toHaveLength(1)
    expect(lifecycle.byRunId(first.pluginRunId)).toBeUndefined()
    expect(lifecycle.byRunId(second.pluginRunId)).toBeDefined()
    // The old fiber must be disposed (cordis DISPOSED state = 4).
    expect(firstFiber.state).toBe(4)
    // The effect disposer from the OLD run must have fired exactly once.
    expect(g.__dedupHalfDisped).toBe(1)
    // The new run is active.
    expect(lifecycle.byRunId(second.pluginRunId)!.fiber.state).toBe(2)
  })
})