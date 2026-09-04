/**
 * Domain data form: schema-validated, change-emitting KV domains over storage
 * backends. The single implementation of the domain layer — consumers depend
 * on this package and never touch backends directly. This is a PURE LIBRARY
 * (no cordis): the nx-pn host owns assembly and wiring.
 *
 * The facility is constructed with explicit ports where the dsh cordis plugin
 * reached the context:
 *   - `storage` — the hub instance whose `backend` registry resolves routes;
 *   - `emit` — dispatch for `domain/changed` change notifications;
 *   - `logger` — warning/error diagnostics.
 * The host mounts the facility under the hub's `domain` form key (so
 * `storage.domain` resolves) and closes every domain it opened at shutdown.
 *
 * Record schemas inside domain specs are zod (see `src/spec.ts` for the
 * rationale); the facility itself performs no config validation.
 * @module @flowot/nx-pn-storage-domain
 */

import type { Storage } from '@flowot/nx-pn-storage'
import { DomainError } from './error.js'
import { descriptorOf } from './spec.js'
import type { DomainSpec } from './spec.js'
import { DomainImpl } from './domain.js'
import type { Domain, DomainEmitter, DomainLogger } from './domain.js'

export { DomainError } from './error.js'
export type { DomainErrorCode, DomainErrorOptions, InvalidRecordDetail } from './error.js'
export { defineDomain, domainTable, descriptorOf } from './spec.js'
export type {
  DomainSpec, DomainGlobalSpec, DomainTableSpec,
  TableKeyOf, TableValueOf, GlobalValueOf,
} from './spec.js'
export type { DomainChanged } from './events.js'
export type { Domain, DomainGlobal, DomainGlobalHandleOf, KvTable } from './domain.js'
export type { DomainEmitter, DomainLogger } from './domain.js'

/**
 * Facility construction ports. Which backend serves which domain is decided
 * here, not globally on the hub: `backend` is the default route and `routes`
 * overrides it per domain name. A route naming an unregistered backend fails
 * loud at `open` with `backend-not-found`.
 */
export interface DomainFacilityOptions {
  /** The storage hub whose backend registry resolves routes. */
  storage: Storage
  /** Default backend name for every domain without an explicit route. Required: there is no universally correct medium. */
  backend: string
  /** Per-domain overrides: domain name → backend name. */
  routes?: Record<string, string>
  /** Dispatches one `domain/changed` notification per durable write. */
  emit: DomainEmitter
  /** Receives the facility's warning/error diagnostics. */
  logger: DomainLogger
}

/**
 * The domain facility. Opens declared domains over routed backends; one
 * facility instance owns the open-domain table and enforces single-open per
 * domain name. A host constructs it once (per storage assembly) and closes it
 * at shutdown via {@link DomainFacility.closeAll}.
 */
export class DomainFacility {
  private readonly domains = new Map<string, DomainImpl>()
  /** Names reserved by an in-flight or completed open, so concurrent opens of one name fail loud. */
  private readonly reserved = new Set<string>()

  /**
   * @param options - Storage hub, route configuration, and the emit/logger ports.
   */
  constructor(private readonly options: DomainFacilityOptions) {}

  /**
   * Open one declared domain. Steps, each failing the whole call: reject a
   * name that is already open (`already-open`); resolve the backend route
   * (`backend-not-found` passes through from the hub); require its `kv` facet
   * (`facet-unsupported`); open the unit projected from the spec (backend
   * `version-mismatch`/`malformed-medium` pass through); load and validate
   * every stored record against the spec's zod schemas (`invalid-record`
   * with the offending table and key — unless the spec declares
   * `invalidRecords: 'backup-and-skip'` and the unit can move documents aside, in
   * which case the failing record is backed up, logged, and skipped);
   * construct the domain.
   *
   * Lifecycle: the CALLER owns the returned handle and closes it via
   * `Domain.close()` (typically as its own shutdown disposer) — the facility
   * does not tie the domain to any consumer fiber. Domains still open when
   * the facility shuts down are closed by {@link DomainFacility.closeAll}.
   * @param spec - The domain declaration, typically from `defineDomain`.
   * @returns the opened domain handle, typed by the spec.
   */
  async open<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    if (this.reserved.has(spec.name)) {
      throw new DomainError('already-open', `domain '${spec.name}' is already open`)
    }
    this.reserved.add(spec.name)
    try {
      const backendName = this.options.routes?.[spec.name] ?? this.options.backend
      const backend = this.options.storage.backend.get(backendName)
      if (!backend.kv) {
        throw new DomainError(
          'facet-unsupported',
          `backend '${backendName}' routed for domain '${spec.name}' has no kv facet`,
        )
      }
      const unit = await backend.kv.open(descriptorOf(spec))
      try {
        const snapshot = await unit.loadAll()
        const tables = new Map<string, Map<string, unknown>>()
        for (const [table, tableSpec] of Object.entries(spec.tables)) {
          const records = new Map<string, unknown>()
          for (const [key, raw] of Object.entries(snapshot.tables[table] ?? {})) {
            let parsed: unknown
            try {
              parsed = parseRecord(spec.name, table, key, () => tableSpec.valueSchema.parse(raw))
            } catch (error) {
              // Backup-and-skip policy (disposable derived data): move the record's
              // document aside, log the concrete failure, and open without the
              // record. Backends that cannot move a document keep the loud path.
              if (spec.invalidRecords !== 'backup-and-skip' || unit.backupRecord === undefined) throw error
              const moved = await unit.backupRecord(table, key)
              // parseRecord always wraps the zod failure as the cause.
              this.options.logger.error(
                `domain '${spec.name}': stored record '${key}' in table '${table}' failed schema validation; `
                + `moved to '${moved}' and treated as absent. Cause: ${String((error as DomainError).cause)}`,
              )
              continue
            }
            records.set(key, parsed)
          }
          tables.set(table, records)
        }
        // A null stored global means "never written": serve `initial` without
        // materializing it — the first `set` writes.
        const globalSpec = spec.global
        const globalValue = globalSpec === undefined
          ? undefined
          : snapshot.global === null
            ? globalSpec.initial
            : parseRecord(spec.name, '', '', () => globalSpec.schema.parse(snapshot.global))
        // The onClosed hook runs strictly after teardown completes: writes
        // landing during the drain still emit domain/changed, and the domain
        // stays resolvable (the package invariant cross-checks each event)
        // until fully closed — only then does the name free up for reopening.
        const domain: DomainImpl = new DomainImpl(
          spec,
          unit,
          tables,
          globalValue,
          () => {
            this.domains.delete(spec.name)
            this.reserved.delete(spec.name)
          },
          { emit: this.options.emit, logger: this.options.logger },
        )
        this.domains.set(spec.name, domain)
        // The single type-erasure point: DomainImpl is the untyped runtime,
        // Domain<S> the spec-typed view; the unknown hop is required because
        // S's conditional global-handle type stays unresolved here.
        return domain as unknown as Domain<S>
      } catch (error) {
        await unit.close()
        throw error
      }
    } catch (error) {
      // Any failure means the domain never registered (nothing can throw
      // after it), so releasing the name reservation is unconditional.
      this.reserved.delete(spec.name)
      throw error
    }
  }

  /**
   * Look up an open domain by name, untyped. Diagnostic surface (change
   * events can be cross-checked against live domain state); typed consumers
   * hold the handle returned by {@link open}.
   * @param name - Domain name.
   * @returns the open domain runtime, or `undefined` when not open.
   */
  get(name: string): DomainImpl | undefined {
    return this.domains.get(name)
  }

  /**
   * Close every domain still open on this facility. The shutdown path for
   * consumers that never called `Domain.close()` themselves; closing is
   * idempotent, so double-closing an already-closed domain is harmless.
   * @returns resolution after every unit is released.
   */
  async closeAll(): Promise<void> {
    await Promise.all([...this.domains.values()].map(domain => domain.close()))
  }
}

/** Run one zod parse, translating failure to `invalid-record` with its location. */
function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`
    throw new DomainError(
      'invalid-record',
      `domain '${domain}': stored ${slot} does not match its schema`,
      { detail: { table, key }, cause: error },
    )
  }
}
