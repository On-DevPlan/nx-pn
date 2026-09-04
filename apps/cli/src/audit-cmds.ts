/**
 * `nx-pn audit list|lastId` — read the audit request trail as data.
 *
 * Two retrieval paths share the SAME query vocabulary (filter → sort →
 * limit) via `applyAuditQuery` from the host package, so live-host REST and
 * cold-start domain reads never drift:
 *   - a long-running host is alive on --port → GET /api/audit?<predicates>
 *     (the host applies the same predicates server-side and returns JSON)
 *   - no live host → ephemeral startHost over the same --data-dir, read the
 *     durable `audit` domain directly, then stop.
 *
 * Output formats (--format, default human):
 *   json   → { ok, lastId, count, records: [...] }         (one object)
 *   jsonl  → one compact JSON record per line               (CI/pipe friendly)
 *   csv    → header + rows (id,ts,method,status,url,durationMs,initiator)
 *   table  → aligned columns
 *   human  → same as table (interactive default)
 */

import { startHost, applyAuditQuery } from '@flowot/nx-pn-host'
import type { AuditRecord } from '@flowot/nx-pn-host'
import type { AuditQueryFlags, CliOptions } from './main.js'
import { probeHost } from './probe.js'

const CSV_COLUMNS = ['id', 'ts', 'method', 'status', 'url', 'durationMs', 'initiator'] as const

function auditQueryFlags(query?: AuditQueryFlags): string {
  if (!query) return ''
  const params = new URLSearchParams()
  if (query.sinceId !== undefined) params.set('sinceId', String(query.sinceId))
  if (query.method !== undefined) params.set('method', query.method)
  if (query.status !== undefined) params.set('status', String(query.status))
  if (query.url !== undefined) params.set('url', query.url)
  if (query.initiator !== undefined) params.set('initiator', query.initiator)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.order !== undefined) params.set('order', query.order)
  return params.toString()
}

/** Query the live host's GET /api/audit (applies the same predicates). */
async function queryLiveHost(port: number, query?: AuditQueryFlags): Promise<AuditRecord[]> {
  const qs = auditQueryFlags(query)
  const url = `http://localhost:${port}/api/audit${qs ? `?${qs}` : ''}`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (res.status !== 200) {
    throw new Error(`audit query failed on live host :${port} (HTTP ${res.status})`)
  }
  const json = (await res.json()) as { ok: boolean; data?: { lastId: number; records: AuditRecord[] }; error?: { message?: string } }
  if (!json.ok || !json.data) {
    throw new Error(`audit query failed on live host :${port}: ${json.error?.message ?? 'no data'}`)
  }
  return json.data.records
}

/** Cold start: boot an ephemeral host over --data-dir, read the durable audit domain. */
async function queryColdStart(opts: CliOptions): Promise<AuditRecord[]> {
  const host = await startHost({ port: 0, dataDir: opts.dataDir, restartFromDataDir: false })
  try {
    const all: AuditRecord[] = []
    for (const [, value] of host.auditDomain.table('records').entries()) {
      all.push(value as AuditRecord)
    }
    // applyAuditQuery types its records as AuditRecord[] — same shape.
    return applyAuditQuery(all, opts.auditQuery ?? {})
  } finally {
    await host.stop()
  }
}

export async function runAuditLastId(opts: CliOptions): Promise<void> {
  if (await probeHost(opts.port)) {
    const records = await queryLiveHost(opts.port, { limit: 1 })
    const lastId = records.length > 0 ? records[0]!.id : 0
    console.log(String(lastId))
    return
  }
  const host = await startHost({ port: 0, dataDir: opts.dataDir, restartFromDataDir: false })
  try {
    // lastId from the durable domain = max id (domain rows are keyed by String(id)).
    let max = 0
    for (const [key] of host.auditDomain.table('records').keys()) {
      const id = Number(key)
      if (Number.isFinite(id) && id > max) max = id
    }
    console.log(String(max))
  } finally {
    await host.stop()
  }
}

export async function runAuditList(opts: CliOptions): Promise<void> {
  let records: AuditRecord[]
  if (await probeHost(opts.port)) {
    records = await queryLiveHost(opts.port, opts.auditQuery)
  } else {
    records = await queryColdStart(opts)
  }

  const format = opts.format ?? 'human'
  switch (format) {
    case 'json':
      console.log(JSON.stringify({ ok: true, count: records.length, records }, null, 2))
      break
    case 'jsonl':
      for (const r of records) console.log(JSON.stringify(r))
      break
    case 'csv':
      console.log(CSV_COLUMNS.join(','))
      for (const r of records) {
        console.log(CSV_COLUMNS.map((c) => String(r[c]).replaceAll(',', '\\,').replaceAll('\n', ' ')).join(','))
      }
      break
    case 'table':
    case 'human':
    default:
      if (records.length === 0) {
        console.log('(no audit records match)')
        break
      }
      // Aligned columns — compute widths from the data.
      const rows = records.map((r) => [
        String(r.id), r.method, String(r.status), r.url,
        `${r.durationMs}ms`, r.initiator,
      ])
      const header = ['id', 'method', 'status', 'url', 'duration', 'initiator']
      const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)))
      const pad = (s: string, w: number) => s.padEnd(w)
      console.log(header.map((h, i) => pad(h, widths[i]!)).join('  '))
      for (const row of rows) {
        console.log(row.map((cell, i) => pad(cell, widths[i]!)).join('  '))
      }
      break
  }
}
