/**
 * Plugins ledger domain — the npm install-by-name registry, now a storage
 * domain instead of the installer's raw `installed.json` file.
 *
 * The ledger maps manifest id → install spec (restart replay source). The
 * single-layout default keeps the whole table in one human-readable
 * ledger file (`<storage>/plugins.json`) — the same legibility the old
 * installed.json offered.
 *
 * Design decision (v1): the ledger domain is authoritative. A pre-existing
 * data-dir `plugins-registry/installed.json` is NOT migrated on first boot
 * — hosts that ran the file-ledger version start with an empty npm-ledger
 * (zip plugins under data-dir/plugins still replay normally; install-by-name
 * plugins must be re-added once). The file is left untouched on disk.
 * @module @flowot/nx-pn-host/src/domains/plugins-domain
 */

import { defineDomain, domainTable } from '@flowot/nx-pn-storage-domain'
import { z } from 'zod'

/** Table holding the manifest-id → install-spec ledger. */
export const PLUGINS_LEDGER_TABLE = 'installed'

/**
 * The npm plugins ledger domain. Values are the installer's `LedgerEntry`
 * shape ({ spec, name, version, installedAt }) validated structurally so a
 * corrupted entry fails the whole open instead of being silently skipped —
 * the ledger is authoritative, not disposable (unlike the audit trail).
 */
export const pluginsSpec = defineDomain({
  name: 'plugins',
  version: 1,
  tables: {
    installed: domainTable(
      z.object({
        spec: z.string(),
        name: z.string(),
        version: z.string(),
        installedAt: z.string(),
      }),
    ),
  },
})

export type PluginsSpec = typeof pluginsSpec

/** Per-id ledger row (mirrors the installer's LedgerEntry). */
export interface PluginsLedgerEntry {
  spec: string
  name: string
  version: string
  installedAt: string
}
