import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Storage } from '@flowot/nx-pn-storage'
import { defineDomain, descriptorOf, DomainFacility, domainTable } from '../index.js'
import type { DomainChanged } from '../events.js'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.js'

const itemSchema = z.object({ label: z.string(), count: z.number().int() })
type Item = z.infer<typeof itemSchema>

const settingsSchema = z.object({ theme: z.string() })

const spec = defineDomain({
  name: 'demo',
  version: 1,
  global: { schema: settingsSchema, initial: { theme: 'plain' } },
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const bareSpec = defineDomain({
  name: 'bare',
  version: 1,
  tables: { rows: domainTable<string, Item>(itemSchema) },
})

/**
 * Build a plain-library harness: one storage hub, one memory backend
 * registered under `memory`, and a facility over it. `config` mirrors the dsh
 * plugin config surface — the facility's default route backend and per-domain
 * route overrides. Extra backends (`nokv`, `sparse`, …) are registered by the
 * individual tests onto the returned hub.
 */
function harness(options?: { pool?: MemoryMediaPool; config?: { backend?: string; routes?: Record<string, string> } }) {
  const storage = new Storage()
  const backend = new MemoryStorageBackend(options?.pool)
  storage.backend.register('memory', backend)
  const changes: DomainChanged[] = []
  const facility = new DomainFacility({
    storage,
    backend: options?.config?.backend ?? 'memory',
    ...options?.config?.routes === undefined ? {} : { routes: options.config.routes },
    emit: (change) => { changes.push(change) },
    logger: { warn: () => {}, error: () => {} },
  })
  // Mounted, not just constructed: the change-event ↔ memory agreement suite
  // and the `storage.domain` getter resolve the facility through the hub.
  storage.mount('domain' as never, facility as never)
  return { storage, backend, facility, changes }
}

const nullLogger = { warn: () => {}, error: () => {} }

describe('defineDomain', () => {
  it('rejects invalid names and versions loudly', () => {
    expect(() => defineDomain({ name: 'Bad-Name', version: 1, tables: {} })).toThrow(/must match/)
    expect(() => defineDomain({ name: 'ok', version: 1.5, tables: {} })).toThrow(/non-negative integer/)
    expect(() => defineDomain({
      name: 'ok', version: 1, tables: { 'Bad Table': domainTable<string, Item>(itemSchema) },
    })).toThrow(/table name/)
  })

  it('rejects a global schema that accepts null (the never-written sentinel)', () => {
    expect(() => defineDomain({
      name: 'ok',
      version: 1,
      global: { schema: settingsSchema.nullable(), initial: null },
      tables: {},
    })).toThrow(/must not accept null/)
  })

  it('validates compatibleVersions entries and projects them onto the descriptor', () => {
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [1.5], tables: {} }))
      .toThrow(/compatibleVersions/)
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [2], tables: {} }))
      .toThrow(/below version/)
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [-1], tables: {} }))
      .toThrow(/compatibleVersions/)
    expect(descriptorOf(defineDomain({ name: 'ok', version: 2, compatibleVersions: [0, 1], tables: {} })))
      .toMatchObject({ compatibleVersions: [0, 1] })
    // An undeclared set is absent from the descriptor.
    expect(descriptorOf(spec)).not.toHaveProperty('compatibleVersions')
  })

  it('rejects an unknown invalidRecords policy', () => {
    expect(() => defineDomain({
      name: 'ok', version: 1, invalidRecords: 'zap' as 'backup-and-skip', tables: {},
    })).toThrow(/invalidRecords/)
  })

  it('rejects an invalid layout and projects the declared one onto the descriptor', () => {
    // A spec built from config can carry any value; the union type is
    // compile-time only, so the runtime boundary check must reject it.
    expect(() => defineDomain({ name: 'ok', version: 1, layout: 'every-record' as 'single', tables: {} }))
      .toThrow(/layout/)
    expect(descriptorOf(defineDomain({ name: 'per', version: 1, layout: 'per-record', tables: {} })))
      .toMatchObject({ name: 'per', layout: 'per-record' })
    // The default (single) layout is absent from the descriptor.
    expect(descriptorOf(spec)).not.toHaveProperty('layout')
  })
})

describe('DomainFacility.open', () => {
  it('opens, reads back stored records, and rejects a second open of the same name', async () => {
    const { facility } = harness()
    const domain = await facility.open(spec)
    await domain.table('items').put('a', { label: 'first', count: 1 })
    await expect(facility.open(spec)).rejects.toMatchObject({ name: 'DomainError', code: 'already-open' })
    expect(domain.table('items').get('a')).toEqual({ label: 'first', count: 1 })
  })

  it('routes per domain name and fails loud on an unregistered route target', async () => {
    const { facility } = harness({ config: { routes: { demo: 'nonexistent' } } })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'backend-not-found',
    })
    // The failed open releases the name for a later attempt.
    const { facility: healthy } = harness()
    await expect(healthy.open(spec)).resolves.toBeDefined()
  })

  it('rejects a backend without the kv facet', async () => {
    const { storage, facility } = harness({ config: { backend: 'nokv' } })
    storage.backend.register('nokv', { close: async () => {} })
    await expect(facility.open(spec)).rejects.toMatchObject({ code: 'facet-unsupported' })
  })

  it('falls back to the default backend when no route table is configured', async () => {
    // A second facility whose config omits `routes` entirely
    // (exactOptionalPropertyTypes forbids an explicit undefined).
    const { storage } = harness()
    const routeless = new DomainFacility({ storage, backend: 'memory', emit: () => {}, logger: nullLogger })
    await expect(routeless.open(bareSpec)).resolves.toBeDefined()
  })

  it('treats a table key the backend omitted from loadAll as empty', async () => {
    // A sparse backend: loadAll omits declared table keys entirely instead of
    // returning them as empty objects.
    const { storage, facility } = harness({ config: { backend: 'sparse' } })
    storage.backend.register('sparse', {
      kv: {
        open: async () => ({
          loadAll: async () => ({ tables: {}, global: null }),
          putRecord: async () => {},
          deleteRecord: async () => {},
          setGlobal: async () => {},
          close: async () => {},
        }),
      },
      close: async () => {},
    })
    const domain = await facility.open(bareSpec)
    expect(domain.table('rows').size).toBe(0)
  })

  it('rejects stored records that fail their schema, naming table and key', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = harness({ pool })
      await (await facility.open(spec)).table('items').put('bad', { label: 'x', count: 2 })
    }
    pool.media.get('demo')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    const { facility } = harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
  })

  it('keeps the rejecting default under backup-and-skip when the backend cannot move documents', async () => {
    // The memory backend has no backupRecord, so the declared policy cannot
    // apply and the open falls back to failing loud.
    const salvageSpec = defineDomain({
      name: 'salvage',
      version: 1,
      invalidRecords: 'backup-and-skip',
      tables: { items: domainTable<string, Item>(itemSchema) },
    })
    const pool = new MemoryMediaPool()
    {
      const { facility } = harness({ pool })
      await (await facility.open(salvageSpec)).table('items').put('bad', { label: 'x', count: 2 })
    }
    pool.media.get('salvage')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    const { facility } = harness({ pool })
    await expect(facility.open(salvageSpec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
  })

  it('rejects a stored global that fails its schema with the global marker', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('demo', 1)
    pool.media.set('demo', { tables: new Map(), global: { theme: 42 } })
    const { facility } = harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: '', key: '' },
    })
  })

  it('passes through a backend version mismatch', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('demo', 7)
    const { facility } = harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })
  })
})

describe('table and snapshot reads', () => {
  it('serves entries, keys, and size as stable snapshots; unknown table names throw', async () => {
    const { facility } = harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    expect(table.size).toBe(2)
    expect([...table.keys()].sort()).toEqual(['a', 'b'])
    expect(new Map(table.entries()).get('a')).toEqual({ label: 'x', count: 1 })
    expect(() => domain.table('nope' as never)).toThrow(/declares no table/)
  })
})

describe('KvTable writes', () => {
  it('serializes concurrent updates on one key without losing increments', async () => {
    const { facility } = harness()
    const table = (await facility.open(spec)).table('items')
    await table.put('counter', { label: 'c', count: 0 })
    await Promise.all(Array.from({ length: 50 }, () =>
      table.update('counter', current => ({ ...current, count: current.count + 1 }))))
    expect(table.get('counter')).toEqual({ label: 'c', count: 50 })
  })

  it('update rejects a missing key; delete reports prior existence', async () => {
    const { facility } = harness()
    const table = (await facility.open(spec)).table('items')
    await expect(table.update('ghost', v => v)).rejects.toMatchObject({ code: 'missing-key' })
    await table.put('a', { label: 'x', count: 1 })
    await expect(table.delete('a')).resolves.toBe(true)
    await expect(table.delete('a')).resolves.toBe(false)
  })

  it('emits domain/changed per durable write, in order, with tombstones and global marker', async () => {
    const { facility, changes } = harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.update('a', current => ({ ...current, count: 2 }))
    await table.delete('a')
    await table.delete('a') // no event: already absent
    await domain.global.set({ theme: 'dark' })
    expect(changes).toEqual([
      { domain: 'demo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 1 } },
      { domain: 'demo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 2 } },
      { domain: 'demo', table: 'items', key: 'a', operation: 'deleted' },
      { domain: 'demo', table: '', key: '', operation: 'put', value: { theme: 'dark' } },
    ])
  })
})

describe('durability failure', () => {
  it('leaves memory untouched and emits nothing when the backend rejects a write', async () => {
    const pool = new MemoryMediaPool()
    const { facility, changes } = harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    const seen = changes.length

    pool.failNextWrites = 3
    await expect(table.put('a', { label: 'x', count: 99 })).rejects.toThrow(/injected/)
    await expect(table.update('a', c => ({ ...c, count: c.count + 1 }))).rejects.toThrow(/injected/)
    await expect(table.delete('a')).rejects.toThrow(/injected/)

    // Reads still serve the pre-failure record; no events leaked.
    expect(table.get('a')).toEqual({ label: 'x', count: 1 })
    expect(pool.media.get('demo')!.tables.get('items')!.get('a')).toEqual({ label: 'x', count: 1 })
    expect(changes).toHaveLength(seen)

    // The chain survives rejections: the next write lands cleanly with no residue.
    await table.update('a', c => ({ ...c, count: c.count + 1 }))
    expect(table.get('a')).toEqual({ label: 'x', count: 2 })
  })

  it('keeps serving initial when the first global set fails durability', async () => {
    const pool = new MemoryMediaPool()
    const { facility } = harness({ pool })
    const domain = await facility.open(spec)
    pool.failNextWrites = 1
    await expect(domain.global.set({ theme: 'dark' })).rejects.toThrow(/injected/)
    expect(domain.global.get()).toEqual({ theme: 'plain' })
    expect(pool.media.get('demo')!.global).toBeNull()
  })
})

describe('global singleton', () => {
  it('serves initial before first set without materializing, then persists the first set', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = harness({ pool })
      const domain = await facility.open(spec)
      expect(domain.global.get()).toEqual({ theme: 'plain' })
      expect(pool.media.get('demo')!.global).toBeNull() // initial never touches the medium
      await domain.global.set({ theme: 'dark' })
      expect(pool.media.get('demo')!.global).toEqual({ theme: 'dark' })
    }
    const { facility } = harness({ pool })
    expect((await facility.open(spec)).global.get()).toEqual({ theme: 'dark' })
  })

  it('throws on access when the spec declares no global', async () => {
    const { facility } = harness()
    const domain = await facility.open(bareSpec)
    expect(() => (domain as { global: unknown }).global).toThrow(/declares no global/)
  })
})

describe('close and lifecycle', () => {
  it('close drains queued writes, then rejects reads and writes, and frees the name', async () => {
    const pool = new MemoryMediaPool()
    const { facility } = harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    const pending = Promise.all([
      table.put('a', { label: 'x', count: 1 }),
      table.put('b', { label: 'y', count: 2 }),
    ])
    await Promise.all([domain.close(), domain.close()]) // idempotent
    await pending // queued before close → still landed
    // Durability is the drain contract: both queued writes reached the medium.
    expect([...pool.media.get('demo')!.tables.get('items')!.keys()].sort()).toEqual(['a', 'b'])
    await expect(table.put('c', { label: 'z', count: 3 })).rejects.toMatchObject({ code: 'closed' })
    expect(() => table.get('a')).toThrow(/closed/)
    // The name is free again: reopening sees the drained state.
    const reopened = await facility.open(spec)
    expect([...reopened.table('items').keys()].sort()).toEqual(['a', 'b'])
  })

  it('closeAll closes domains the consumer never closed', async () => {
    const { facility } = harness()
    const domain = await facility.open(bareSpec)
    const table = domain.table('rows')
    await table.put('a', { label: 'x', count: 1 })
    await facility.closeAll()
    await expect(table.put('b', { label: 'y', count: 2 })).rejects.toMatchObject({ code: 'closed' })
  })

  it('contains a throwing domain/changed listener without rejecting the committed write', async () => {
    const pool = new MemoryMediaPool()
    const storage = new Storage()
    const backend = new MemoryStorageBackend(pool)
    storage.backend.register('memory', backend)
    const warns: string[] = []
    // A facility whose emit port throws (a hostile observer): DomainImpl must
    // contain the failure — the write is already committed (medium and memory
    // both hold the new state) — and log via the warn port instead.
    const facilityThrows = new DomainFacility({
      storage,
      backend: 'memory',
      emit: () => { throw new Error('hostile observer') },
      logger: { warn: m => { warns.push(m) }, error: () => {} },
    })
    const domainThrows = await facilityThrows.open(spec)
    const table = domainThrows.table('items')
    await expect(table.put('a', { label: 'x', count: 1 })).resolves.toBeUndefined()
    // The commit survived intact on both planes…
    expect(table.get('a')).toEqual({ label: 'x', count: 1 })
    expect(pool.media.get('demo')!.tables.get('items')!.get('a')).toEqual({ label: 'x', count: 1 })
    // …and the containment was reported through the logger port.
    expect(warns.some(message => message.includes('hostile observer'))).toBe(true)
    // The chain is unpoisoned: subsequent writes proceed normally.
    await expect(table.delete('a')).resolves.toBe(true)
  })
})

describe('storage.domain mounting', () => {
  it('resolves the mounted facility through the hub domain getter', async () => {
    const { storage, facility } = harness()
    expect(storage.domain).toBe(facility)
  })
})
