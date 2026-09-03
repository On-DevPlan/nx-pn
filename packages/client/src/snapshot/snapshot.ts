/**
 * Plugin/audit snapshot reconciliation — what the browser does after a
 * (re)connect. Spec §4.5.4:
 *
 *   - on connect the server pushes an initial `snapshot.respond`;
 *   - the client may also send `snapshot.request { sinceId? }` and the
 *     server answers with audit records newer than sinceId plus the
 *     full current plugin manifest.
 *
 * The client-side reconcile step (install/remove browser halves to match
 * the manifest) lives in BrowserRuntime and is exercised with the real
 * loader in Plan 4; this module owns the frame-level state machine only.
 */

import type { Manifest } from '@flowot/nx-pn-core'

/** Plugin manifest entry as pushed in snapshot payloads. */
export interface PluginManifestEntry {
  id: string
  pluginRunId: string
  manifest: Manifest
}

export interface SnapshotData {
  generation: number
  auditLastId: number
  records: unknown[]
  plugins: PluginManifestEntry[]
}

/** Server `audit.append` push (payload is the raw record). */
export interface AuditPush {
  id: number
  ts: number
  initiator: string
  method: string
  url: string
  [key: string]: unknown
}

export function isPluginManifestEntry(value: unknown): value is PluginManifestEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as { id?: unknown; pluginRunId?: unknown; manifest?: unknown }
  return typeof v.id === 'string' && typeof v.pluginRunId === 'string' && typeof v.manifest === 'object'
}

/** Parse a `snapshot.respond` payload. */
export function parseSnapshot(payload: unknown): SnapshotData | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const p = payload as { generation?: unknown; auditLastId?: unknown; records?: unknown; plugins?: unknown }
  const generation = typeof p.generation === 'number' ? p.generation : 0
  const auditLastId = typeof p.auditLastId === 'number' ? p.auditLastId : 0
  const records = Array.isArray(p.records) ? p.records : []
  const pluginsRaw = Array.isArray(p.plugins) ? p.plugins : []
  return {
    generation,
    auditLastId,
    records,
    plugins: pluginsRaw.filter(isPluginManifestEntry),
  }
}
