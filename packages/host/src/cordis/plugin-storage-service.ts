/**
 * Plugin namespace storage (v2) — per-plugin KV domains behind a small
 * handle injected on the plugin ctx as `ctx.pluginStorage`.
 *
 * Every loaded plugin owns a private domain named `plugin-<id>` with three
 * tables — `settings`, `cache`, `state` — persisted under the json backend
 * (`<storage>/plugin-<normalized-id>/<table>/<key>.json`, per-record layout;
 * the directory name uses the domain-name-normalized id since the json
 * backend derives file paths from the unit descriptor name). The manifest
 * id is `^[a-z0-9-]+$` (core Manifest validation); hyphens are mapped to
 * underscores by {@link nsDomainName} to satisfy the storage domain-name
 * rule `^[a-z][a-z0-9_]*$`.
 *
 * Lifecycle: the plugin ns domain is opened by `PluginLifecycle.register`
 * (which hands the open promise back to the loader / installer — the caller
 * awaits it BEFORE `ctx.registry.plugin(...)`, so the handle below is
 * backed by an open domain by apply time; an open failure fails the load
 * loud). `remove()` closes the domain AFTER the fiber is disposed (a
 * stopped plugin can no longer write). Records persist across remove →
 * re-install, so a plugin's settings survive an upgrade cycle.
 *
 * v1 quota: each table caps at {@link MAX_RECORDS_PER_TABLE} records; a
 * put that would exceed the cap rejects with `quota-exceeded`. Size-based
 * quotas (bytes) need value accounting and are left TODO.
 *
 * The handle handed to plugin code is a plain object — it is NOT itself a
 * cordis Service. (A cordis-visible `pluginStorage` Service also exists in
 * host-context.ts for non-wrapped callers; both resolve the same domain.)
 * @module @flowot/nx-pn-host/src/cordis/plugin-storage-service
 */

import { defineDomain, domainTable } from '@flowot/nx-pn-storage-domain'
import type { Domain, DomainSpec, KvTable } from '@flowot/nx-pn-storage-domain'
import { z } from 'zod'

/** The three namespace tables every plugin domain declares. */
export const PLUGIN_NS_TABLES = ['settings', 'cache', 'state'] as const
export type PluginTableName = (typeof PLUGIN_NS_TABLES)[number]

/** Per-table record cap (v1 quota — size quota is TODO). */
export const MAX_RECORDS_PER_TABLE = 1000

/** Stable error codes surfaced by the namespace handle / RPC layer. */
export type PluginStorageErrorCode =
  | 'plugin-ns-denied'
  | 'no-such-run'
  | 'quota-exceeded'
  | 'table-denied'

export class PluginStorageError extends Error {
  override readonly name = 'PluginStorageError'
  constructor(
    public readonly code: PluginStorageErrorCode,
    message?: string,
  ) {
    super(message ?? code)
  }
}

/** A plugin namespace domain (the `plugin-<id>` unit, all three tables). */
export type PluginNsDomain = Domain<DomainSpec>

/**
 * Manifest ids are `^[a-z0-9-]+$` (core validation); domain names require
 * `^[a-z][a-z0-9_]*$` (storage `UNIT_NAME_RE`). Map hyphens to underscores
 * so any valid plugin id produces a valid domain name — the on-disk
 * directory `<storage>/plugin-<id>/...` keeps the original id verbatim
 * (the directory name is not constrained by `UNIT_NAME_RE`), only the
 * domain unit name inside the unit tree is normalized.
 */
function nsDomainName(id: string): string {
  return `plugin-${id}`.replaceAll('-', '_')
}

/**
 * Declare one plugin's namespace domain. The domain name embeds the plugin
 * id, so every plugin is isolated on the medium AND in memory (single-open
 * per name enforced by the facility).
 */
export function pluginNsSpec(id: string): DomainSpec {
  return defineDomain({
    name: nsDomainName(id),
    version: 1,
    layout: 'per-record',
    invalidRecords: 'backup-and-skip',
    tables: {
      settings: domainTable<string, unknown>(z.json()),
      cache: domainTable<string, unknown>(z.json()),
      state: domainTable<string, unknown>(z.json()),
    },
  })
}

/** One table of a plugin namespace — sync reads, async durable writes. */
export interface PluginNsTable {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  update(key: string, fn: (current: unknown) => unknown): Promise<unknown>
  keys(): IterableIterator<string>
  /** Current record count (quota accounting). */
  readonly size: number
}

/** The handle a plugin receives as `ctx.pluginStorage`. */
export interface PluginStorageHandle {
  /** Namespace domain name (`plugin-<id>`); informational. */
  readonly ns: string
  table(name: PluginTableName): PluginNsTable
}

/**
 * Quota-enforcing view over one domain table. Reads pass straight through
 * (the domain's in-memory state is authoritative); `put` checks the record
 * cap before enqueuing the durable write. The check runs pre-enqueue, so
 * two concurrent puts of brand-new keys can both pass at `size == cap - 1`
 * and land `cap + 1` records — accepted for v1 (the cap is a guard
 * against unbounded growth, not a hard invariant).
 */
class QuotaTable implements PluginNsTable {
  constructor(
    private readonly ns: string,
    private readonly tableName: PluginTableName,
    private readonly table: KvTable<string, unknown>,
  ) {}

  get(key: string): unknown {
    return this.table.get(key)
  }

  async put(key: string, value: unknown): Promise<void> {
    if (this.table.get(key) === undefined && this.table.size >= MAX_RECORDS_PER_TABLE) {
      throw new PluginStorageError(
        'quota-exceeded',
        `plugin ns '${this.ns}' table '${this.tableName}' exceeds ${MAX_RECORDS_PER_TABLE} records (size quota TODO)`,
      )
    }
    await this.table.put(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.table.delete(key)
  }

  async update(key: string, fn: (current: unknown) => unknown): Promise<unknown> {
    return this.table.update(key, fn)
  }

  keys(): IterableIterator<string> {
    return this.table.keys()
  }

  get size(): number {
    return this.table.size
  }
}

/**
 * Build the `ctx.pluginStorage` handle over an OPEN plugin namespace
 * domain. The loader calls this after `await entry.storagePromise`, so the
 * domain is live by the time any plugin code touches the handle.
 */
export function makePluginStorage(domain: PluginNsDomain, id: string): PluginStorageHandle {
  const ns = nsDomainName(id)
  const tables = new Map<PluginTableName, PluginNsTable>()
  for (const name of PLUGIN_NS_TABLES) {
    tables.set(name, new QuotaTable(ns, name, domain.table(name)))
  }
  return {
    ns,
    table(name: PluginTableName): PluginNsTable {
      const t = tables.get(name)
      if (!t) throw new PluginStorageError('table-denied', `table '${name}' is not in namespace ${ns}`)
      return t
    },
  }
}
