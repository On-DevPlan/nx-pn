/**
 * Audit domain declaration — durable copy of the audit trail.
 *
 * The ring buffer is the live view (WS push + REST); this domain is the
 * medium the buffer replays from across host restarts. Every audit write is
 * persisted to the `records` table BEFORE the record enters the buffer, so
 * the durable set and the ring buffer never diverge (a failed persist means the
 * record exists in neither — audit recording can never block the business
 * request it describes).
 *
 * Layout is `per-record`: one record file per record id under
 * `<storage>/audit/records/<id>.json` — the trail grows without rewriting a
 * whole-unit publish per write, and an individually corrupted record is
 * backed up and skipped instead of bricking the trail (v1 policy: the audit
 * history is disposable derived data, so a malformed record must not take
 * the whole domain down). Record fields are NOT schema-validated here: the
 * `AuditRecord` TypeScript shape (client/audit-record.ts) is the contract
 * and the zod schema accepts any JSON so future field additions never reject
 * stored history.
 * @module @flowot/nx-pn-host/src/domains/audit-domain
 */

import { defineDomain, domainTable } from '@flowot/nx-pn-storage-domain'
import { z } from 'zod'

/** Table holding every durable audit record, keyed by `String(id)`. */
export const AUDIT_RECORDS_TABLE = 'records'

/**
 * The audit domain declaration. `z.json()` accepts any JSON value at the
 * durable boundary; the handle is typed `unknown` so the typed writer (the
 * audit middleware) can put an `AuditRecord` without a cast — record
 * structure is the TS contract, and future field additions must never
 * reject stored history on upgrade.
 */
export const auditSpec = defineDomain({
  name: 'audit',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    records: domainTable<string, unknown>(z.json()),
  },
})

export type AuditSpec = typeof auditSpec
