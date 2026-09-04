import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Storage } from '@flowot/nx-pn-storage'
import { DomainFacility, defineDomain, domainTable } from '../index.js'
import type { DomainChanged } from '../events.js'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.js'

/**
 * Lightweight equivalent of the dsh `storage-domain/invariant` companion
 * (which depended on the `@deepseek-ai/dsh-invariants` framework, not ported).
 * The invariant under test is unchanged: every `domain/changed` event must
 * agree with the emitting domain's authoritative in-memory state — writes emit
 * strictly after mutating memory and the write chain serializes them, so at
 * emission time the event's snapshot equals the current read. Any divergence
 * means a write path skipped the chain or emitted a stale value.
 *
 * Where dsh checked each emission on a global event bus, the port-based
 * equivalent checks inside the emit handler (the host's injection point),
 * resolving the emitting domain through the facility and asserting agreement
 * inline — mirroring the invariant's core assertions. Synthetic hostile events
 * are checked by driving the same checker directly.
 */

const itemSchema = z.object({ n: z.number() })
type Item = z.infer<typeof itemSchema>

const spec = defineDomain({
  name: 'inv',
  version: 1,
  global: { schema: itemSchema, initial: { n: 0 } },
  tables: { rows: domainTable<string, Item>(itemSchema) },
})

/** The dsh invariant core, expressed as a plain checker over live domain state. */
function checkAgreement(
  facility: DomainFacility,
  failures: string[],
): (change: DomainChanged) => void {
  return (change) => {
    const domain = facility.get(change.domain)
    if (domain === undefined) {
      failures.push(`domain/changed for '${change.domain}' emitted while that domain is not open`)
      return
    }
    if (change.table === '') {
      // Global write: the event snapshot must be the current global value.
      if (domain.global.get() !== change.value) {
        failures.push(`domain/changed global value for '${change.domain}' differs from the in-memory global`)
      }
      return
    }
    const current = domain.table(change.table).get(change.key)
    switch (change.operation) {
      case 'deleted':
        if (current !== undefined) {
          failures.push(
            `domain/changed deletion of '${change.domain}'.'${change.table}'['${change.key}'] `
            + 'emitted while the record is still in memory',
          )
        }
        return
      case 'put':
        if (current !== change.value) {
          failures.push(
            `domain/changed value for '${change.domain}'.'${change.table}'['${change.key}'] `
            + 'differs from the in-memory record',
          )
        }
        return
      default:
        change satisfies never
    }
  }
}

/** A facility whose emit port cross-checks each event against live domain state, collecting failures. */
function invariantHarness(pool?: MemoryMediaPool) {
  const storage = new Storage()
  storage.backend.register('memory', new MemoryStorageBackend(pool))
  const failures: string[] = []
  // The checker needs the facility, which needs the emit port — route through
  // a mutable slot assigned once the facility exists (the slot only runs
  // during writes, never during construction).
  let emit: (change: DomainChanged) => void = () => {}
  const facility = new DomainFacility({
    storage,
    backend: 'memory',
    emit: (change) => { emit(change) },
    logger: { warn: () => {}, error: () => {} },
  })
  emit = checkAgreement(facility, failures)
  storage.mount('domain' as never, facility as never)
  return { storage, facility, failures }
}

describe('domain change-event agreement', () => {
  it('accepts every write shape emitted by the real write paths', async () => {
    const { facility, failures } = invariantHarness()
    const domain = await facility.open(spec)
    const rows = domain.table('rows')
    await rows.put('a', { n: 1 })
    await rows.update('a', current => ({ n: current.n + 1 }))
    await expect(rows.delete('a')).resolves.toBe(true)
    await domain.global.set({ n: 5 })
    expect(failures).toEqual([])
  })

  it('rejects a synthetic event for a domain that is not open', () => {
    const { facility } = invariantHarness()
    const failures: string[] = []
    checkAgreement(facility, failures)({
      domain: 'ghost', table: 'rows', key: 'a', operation: 'put', value: { n: 1 },
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('not open')
  })

  it('rejects a synthetic put event whose value is not the in-memory record', async () => {
    const { facility } = invariantHarness()
    const domain = await facility.open(spec)
    await domain.table('rows').put('a', { n: 1 })
    const failures: string[] = []
    checkAgreement(facility, failures)({
      domain: 'inv', table: 'rows', key: 'a', operation: 'put', value: { n: 999 },
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('differs from the in-memory record')
  })

  it('rejects a synthetic deletion event while the record is still in memory', async () => {
    const { facility } = invariantHarness()
    const domain = await facility.open(spec)
    await domain.table('rows').put('a', { n: 1 })
    const failures: string[] = []
    checkAgreement(facility, failures)({
      domain: 'inv', table: 'rows', key: 'a', operation: 'deleted',
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('emitted while the record is still in memory')
  })

  it('rejects a synthetic global event whose value is not the in-memory global', async () => {
    const { facility } = invariantHarness()
    await facility.open(spec)
    const failures: string[] = []
    checkAgreement(facility, failures)({
      domain: 'inv', table: '', key: '', operation: 'put', value: { n: 42 },
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('differs from the in-memory global')
  })

  it('tolerates an event outside the closed union without failing falsely', async () => {
    const { facility } = invariantHarness()
    const domain = await facility.open(spec)
    await domain.table('rows').put('a', { n: 1 })
    const failures: string[] = []
    // Merge-hostile input: the closed union's satisfies-never default arm is
    // unreachable in typed code; an untyped emit must not crash the check.
    checkAgreement(facility, failures)({
      domain: 'inv', table: 'rows', key: 'a', operation: 'exotic',
    } as unknown as DomainChanged)
    expect(failures).toEqual([])
  })

  it('still agrees across a process-restart reopen (medium state equals memory state)', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility, failures } = invariantHarness(pool)
      const domain = await facility.open(spec)
      await domain.table('rows').put('a', { n: 1 })
      await domain.global.set({ n: 5 })
      expect(failures).toEqual([])
    }
    // Reopen the same medium: the seeded events of the first process are not
    // re-emitted, and every new write still agrees.
    const { facility, failures } = invariantHarness(pool)
    const reopened = await facility.open(spec)
    expect(reopened.table('rows').get('a')).toEqual({ n: 1 })
    expect(reopened.global.get()).toEqual({ n: 5 })
    await reopened.table('rows').put('b', { n: 2 })
    expect(failures).toEqual([])
  })
})
