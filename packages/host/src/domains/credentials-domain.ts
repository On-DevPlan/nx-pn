/**
 * Credentials domain — durable resolved-credential cache.
 *
 * The host's `credentials` cordis service resolves a credential hash to a
 * secret for outbound requests. v1 keeps the resolved map in a storage
 * domain (rather than the MVP no-op resolver) so a future `add-credential`
 * command can persist secrets across restarts.
 *
 * Table `resolved`: hash → stored secret. Per-record layout: each credential
 * is its own record, disposable and individually deletable. Malformed or
 * stale documents back up and skip instead of taking the domain down (a
 * corrupted secret is re-resolvable; it must not brick every other secret).
 *
 * SECURITY NOTE: the values here are secrets. The json backend writes plain
 * files under the host data dir (chmod 0700 on creation). v1 ships no
 * encryption — the value of persisting resolved credentials is functional
 * (survive restarts), and real secret management is out of scope.
 * @module @flowot/nx-pn-host/src/domains/credentials-domain
 */

import { defineDomain, domainTable } from '@flowot/nx-pn-storage-domain'
import { z } from 'zod'

/** Table holding hash → resolved secret. */
export const CREDENTIALS_RESOLVED_TABLE = 'resolved'

/**
 * Credentials domain declaration. Values are opaque strings; the schema
 * accepts any JSON string.
 */
export const credentialsSpec = defineDomain({
  name: 'credentials',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    resolved: domainTable(z.string()),
  },
})

export type CredentialsSpec = typeof credentialsSpec
