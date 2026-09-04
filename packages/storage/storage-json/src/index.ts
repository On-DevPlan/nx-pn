/**
 * JSON storage backend: one human-readable document per unit under a
 * configured root — a whole-unit file (`single` layout) or one document per
 * record (`per-record` layout), published by atomic rewrite. This is a PURE
 * LIBRARY (no cordis): the nx-pn host owns assembly.
 *
 * Host assembly pattern:
 * ```ts
 * const storage = new Storage()
 * const backend = new JsonStorageBackend(root)          // constructor(root: string)
 * const dispose = storage.backend.register('json', backend)
 * // ... serve consumers ...
 * dispose()                                             // unregister first
 * await backend.close()                                 // then release the medium
 * ```
 * @module @flowot/nx-pn-storage-json
 */

import { mkdir } from 'node:fs/promises'
import { StorageError, UNIT_NAME_RE } from '@flowot/nx-pn-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@flowot/nx-pn-storage'
import { openSingleUnit } from './single-unit.js'
import { openPerRecordUnit } from './per-record-unit.js'

/**
 * JSON backend configuration. In dsh this package was a cordis plugin whose
 * `Config` was validated by schemastery at load time; here validation is the
 * caller's responsibility and only the plain interface remains.
 */
export interface Config {
  /** Directory holding one `<unit>.json` file (or `<unit>/` tree) per unit. */
  root: string
}

/**
 * JSON backend: owns the file-tree root and serves the `kv` facet.
 * `root` has NO default on purpose: a `process.cwd()` fallback would scatter
 * unit files wherever the process happens to start; assemblies state the
 * location explicitly.
 */
export class JsonStorageBackend implements StorageBackend {
  private readonly open = new Map<string, KvUnit>()
  // Reserved synchronously at open() entry so a concurrent open of the same
  // unit fails, and close() can await opens still in flight.
  private readonly opening = new Map<string, Promise<KvUnit>>()
  private closed = false

  constructor(private readonly root: string) {}

  readonly kv: KvFacet = {
    // The body up to the first await runs synchronously, so the opening-slot
    // reservation below still excludes a concurrent open of the same unit.
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError('closed', 'json backend is closed')
      validateDescriptor(descriptor)
      if (this.open.has(descriptor.name) || this.opening.has(descriptor.name)) {
        // Double-open is a caller bug, not a medium condition.
        throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
      }
      const opening = this.openUnit(descriptor)
      this.opening.set(descriptor.name, opening)
      return opening.finally(() => this.opening.delete(descriptor.name))
    },
  }

  private async openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    // The two layouts differ in medium shape only; each opener owns its own
    // path convention under the shared root.
    const onClose = () => this.open.delete(descriptor.name)
    const unit = descriptor.layout === 'per-record'
      ? await openPerRecordUnit(descriptor, this.root, onClose)
      : await openSingleUnit(descriptor, this.root, onClose)
    if (this.closed) {
      // The backend closed while this open was in flight: do not hand out a
      // live unit past close().
      await unit.close()
      throw new StorageError('closed', 'json backend is closed')
    }
    this.open.set(descriptor.name, unit)
    return unit
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
    }
    await Promise.allSettled([...this.opening.values()])
    for (const unit of [...this.open.values()]) {
      await unit.close()
    }
  }
}

function validateDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}
