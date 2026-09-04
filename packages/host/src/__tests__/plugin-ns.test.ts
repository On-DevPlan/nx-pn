/**
 * Plugin namespace storage (v2): per-plugin `plugin-<id>` domains.
 *
 *   1. Loaded plugins get an OPEN namespace domain; apply-time
 *      `ctx.pluginStorage` writes land under
 *      <dataDir>/storage/plugin-<id>/<table>/<key>.json.
 *   2. Namespaces are isolated: two plugins running the SAME host-half
 *      source keep independent counters.
 *   3. Data survives remove → re-install (the domain closes on remove
 *      but the medium keeps the records; the next run reopens them).
 *   4. lifecycle.remove closes the ns domain AFTER the fiber disposes.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { startHost, type StartedHost } from '../index.js'

const handles: StartedHost[] = []
const dataDirs: string[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.stop()
  }
  for (const d of dataDirs.splice(0)) {
    await rm(d, { recursive: true, force: true })
  }
})

// CRC32 + STORED zip writer (mirrors loader.test.ts).
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.byteLength; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(parts: Array<[string, string]>): Uint8Array {
  const entries = parts.map(([name, data]) => ({ name, data: Buffer.from(data, 'utf-8') }))
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
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(Buffer.concat(central).byteLength, 12)
  eocd.writeUInt32LE(Buffer.concat(local).byteLength, 16)
  return Buffer.concat([...local, ...central, eocd])
}

/**
 * Host half that increments `settings.bootCount` in its own namespace on
 * every activation and records its namespace name into `state.ns`. Same
 * source for every plugin id — isolation is the point.
 *
 * The writes are awaited so fiber activation does not resolve until the
 * records are durable — matching the dsh `domain/changed` semantics (writes
 * resolve after the backend acknowledges durability; events emit only on
 * durable landed writes). Tests that read back after loader.load() can
 * therefore assert synchronously without race windows.
 */
function nsDemoHostSource(): string {
  return `
const plugin = async function (ctx) {
  const storage = ctx.pluginStorage
  const settings = storage.table('settings')
  const state = storage.table('state')
  const current = settings.get('bootCount')
  const next = (typeof current === 'number' ? current : 0) + 1
  state.put('ns', storage.ns)
  await settings.put('bootCount', next)
  ctx.logger.info('[ns-demo] ' + storage.ns + ' bootCount=' + next)
}
export default plugin
`
}

function nsDemoZip(id: string): Uint8Array {
  return makeZip([
    ['manifest.json', JSON.stringify({
      schemaVersion: 1,
      id,
      version: '1.0.0',
      title: id,
      halves: { host: { entry: 'host.js' } },
    })],
    ['host.js', nsDemoHostSource()],
  ])
}

async function makeHost(): Promise<{ host: StartedHost; dataDir: string }> {
  const osTmp = await realpath(tmpdir())
  const dataDir = await mkdtemp(join(osTmp, 'nx-pn-plugin-ns-'))
  dataDirs.push(dataDir)
  const host = await startHost({ port: 0, dataDir })
  handles.push(host)
  return { host, dataDir }
}

/** Poll until pred returns a value (the ns write is async-but-fast). */
async function waitFor<T>(pred: () => T | undefined, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = pred()
    if (hit !== undefined) return hit
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('plugin namespace storage (v2)', () => {
  it('opens a per-plugin domain; apply-time writes land on the medium', async () => {
    const { host, dataDir } = await makeHost()
    const result = await host.loader.load({ zipBytes: nsDemoZip('nsdemo') })
    const entry = host.lifecycle.byRunId(result.pluginRunId)
    expect(entry).toBeDefined()
    expect(entry!.storageDomain).toBeDefined()
    expect(entry!.storageDomain!.name).toBe('plugin_nsdemo')

    // The apply-time increment landed in the domain (and on the medium).
    const count = await waitFor(
      () => (entry!.storageDomain!.table('settings').get('bootCount') as number | undefined),
      5000,
      'bootCount in plugin_nsdemo',
    )
    expect(count).toBe(1)

    const mediumPath = join(dataDir, 'storage', 'plugin_nsdemo', 'settings', 'bootCount.json')
    expect((await stat(mediumPath)).isFile()).toBe(true)
  })

  it('namespaces are isolated between plugins running the same source', async () => {
    const { host } = await makeHost()
    await host.loader.load({ zipBytes: nsDemoZip('plug-alpha') })
    await host.loader.load({ zipBytes: nsDemoZip('plug-beta') })

    const alpha = await waitFor(
      () => host.lifecycle.listById('plug-alpha')[0]?.storageDomain?.table('settings').get('bootCount') as number | undefined,
      5000,
      'alpha bootCount',
    )
    const beta = await waitFor(
      () => host.lifecycle.listById('plug-beta')[0]?.storageDomain?.table('settings').get('bootCount') as number | undefined,
      5000,
      'beta bootCount',
    )
    // Independent counters, independent namespace names.
    expect(alpha).toBe(1)
    expect(beta).toBe(1)
    expect(host.lifecycle.listById('plug-alpha')[0]!.storageDomain!.table('state').get('ns')).toBe('plugin_plug_alpha')
    expect(host.lifecycle.listById('plug-beta')[0]!.storageDomain!.table('state').get('ns')).toBe('plugin_plug_beta')
  })

  it('data survives remove → re-install (domain closes, medium keeps records)', async () => {
    const { host, dataDir } = await makeHost()
    const first = await host.loader.load({ zipBytes: nsDemoZip('nsdemo') })
    const firstDomain = host.lifecycle.byRunId(first.pluginRunId)!.storageDomain!
    await waitFor(
      () => (firstDomain.table('settings').get('bootCount') as number | undefined),
      5000,
      'first bootCount',
    )

    // remove: fiber disposed first, THEN the ns domain closed.
    await host.lifecycle.remove(first.pluginRunId)
    let closed = false
    try {
      firstDomain.table('settings').get('bootCount')
    } catch {
      closed = true
    }
    expect(closed).toBe(true) // reads reject once the domain is closed

    // The medium still holds the record.
    expect((await stat(join(dataDir, 'storage', 'plugin_nsdemo', 'settings', 'bootCount.json'))).isFile()).toBe(true)

    // Re-install the same plugin → the reopened namespace continues at 2.
    const second = await host.loader.load({ zipBytes: nsDemoZip('nsdemo') })
    const secondEntry = host.lifecycle.byRunId(second.pluginRunId)!
    expect(secondEntry.storageDomain!.name).toBe('plugin_nsdemo')
    const count = await waitFor(
      () => (secondEntry.storageDomain!.table('settings').get('bootCount') as number | undefined),
      5000,
      're-installed bootCount',
    )
    expect(count).toBe(2)
  })

  it('stop closes every open namespace domain at shutdown; restart replay reopens it', async () => {
    const { host } = await makeHost()
    const r = await host.loader.load({ zipBytes: nsDemoZip('nsdemo') })
    const domain = host.lifecycle.byRunId(r.pluginRunId)!.storageDomain!
    const dataDir = host.dataDir
    await host.stop()
    handles.splice(handles.indexOf(host), 1)
    expect(() => domain.table('settings').get('bootCount')).toThrow()

    // A fresh host on the same dataDir replays the persisted zip through
    // the loader → the SAME namespace domain reopens and the counter the
    // medium preserved continues: 1 (first run) + 1 (this restart) = 2.
    const host2 = await startHost({ port: 0, dataDir })
    handles.push(host2)
    const restarted = host2.lifecycle.list().find((e) => e.id === 'nsdemo')
    expect(restarted).toBeDefined()
    expect(restarted!.storageDomain).toBeDefined()
    const count = await waitFor(
      () => (restarted!.storageDomain!.table('settings').get('bootCount') as number | undefined),
      5000,
      'restart-replay bootCount',
    )
    expect(count).toBe(2)
  })
})
