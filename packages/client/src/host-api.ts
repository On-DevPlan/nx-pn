/**
 * Host REST API client + shared types used by the web shell.
 *
 * The core pages (Audit/Replay/Plugins) read page data over REST
 * (`GET /api/audit`, `GET /api/plugins`, `POST /api/replay`) and use WS
 * only for live push. These are thin fetch wrappers around the host's
 * documented routes (spec §6, Plan-3 scope).
 *
 * Wire envelope used by every host API route:
 *   { ok: true, data: ... } | { ok: false, error: { code, message } }
 */

import type { AuditRecord } from './types.js'
import type { Manifest } from '@flowot/nx-pn-core'

export type { AuditRecord } from './types.js'

export interface ApiErrorPayload {
  code: string
  message?: string
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface PluginSummary {
  id: string
  pluginRunId: string
  manifest: Manifest
}

export interface AuditSnapshot {
  records: AuditRecord[]
  lastId: number
}

export interface ReplayRequest {
  recordId: number
  overrides?: {
    method?: AuditRecord['method']
    url?: string
    headers?: Record<string, string>
    body?: string
  }
}

/** Parse the standard `{ ok, data|error }` envelope; throws ApiError. */
async function readJson<T>(res: Response): Promise<T> {
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new ApiError('response/not-json', `host returned ${res.status} ${res.statusText}`)
  }
  if (!json || typeof json !== 'object') {
    throw new ApiError('response/malformed', 'host returned a non-object payload')
  }
  const body = json as { ok?: boolean; data?: T; error?: ApiErrorPayload }
  if (body.ok === false || !res.ok) {
    throw new ApiError(
      body.error?.code ?? 'http/error',
      body.error?.message ?? `HTTP ${res.status}`,
      res.status,
    )
  }
  return body.data as T
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  return readJson<T>(res)
}

/** GET /api/audit (optionally since an id). */
export function fetchAudit(base: string, sinceId?: number): Promise<AuditSnapshot> {
  const q = sinceId !== undefined ? `?sinceId=${sinceId}` : ''
  return request<AuditSnapshot>(`${base}/api/audit${q}`)
}

/** POST /api/replay { recordId, overrides } → replay audit result. */
export function fetchReplay(base: string, req: ReplayRequest): Promise<import('./types.js').AuditResponse> {
  return request<import('./types.js').AuditResponse>(`${base}/api/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  })
}

/** GET /api/plugins → plugin summaries. */
export function fetchPluginList(base: string): Promise<PluginSummary[]> {
  return request<PluginSummary[]>(`${base}/api/plugins`)
}

/** POST /api/plugins/:runId/stop. */
export function stopPlugin(base: string, pluginRunId: string): Promise<void> {
  return request<void>(`${base}/api/plugins/${encodeURIComponent(pluginRunId)}/stop`, { method: 'POST' })
}

/** POST /api/plugins/:runId/start — re-activate a stopped plugin. */
export function startPlugin(base: string, pluginRunId: string): Promise<PluginSummary> {
  return request<PluginSummary>(`${base}/api/plugins/${encodeURIComponent(pluginRunId)}/start`, { method: 'POST' })
}

/** POST /api/plugins/:runId/remove. */
export function removePlugin(base: string, pluginRunId: string): Promise<void> {
  return request<void>(`${base}/api/plugins/${encodeURIComponent(pluginRunId)}/remove`, { method: 'POST' })
}

/** POST /api/plugins/:runId/uninstall — remove + drop from the npm ledger. */
export function uninstallPlugin(base: string, pluginRunId: string): Promise<void> {
  return request<void>(`${base}/api/plugins/${encodeURIComponent(pluginRunId)}/uninstall`, { method: 'POST' })
}

/** Result of POST /api/plugins/install. */
export interface PluginInstallResult {
  id: string
  pluginRunId: string
  name: string
  version: string
}

/**
 * POST /api/plugins/install — install a plugin by npm package name/spec
 * (the npx-plugin primary path). Returns 201 with { id, pluginRunId, name,
 * version } on success.
 */
export function installPluginByName(base: string, spec: string): Promise<PluginInstallResult> {
  return request<PluginInstallResult>(`${base}/api/plugins/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spec }),
  })
}

/**
 * POST /api/plugins — multipart upload of a plugin zip (field name `zip`).
 * Returns 201 with { id, pluginRunId, manifest } on success.
 */
export async function uploadPlugin(base: string, zip: Blob, filename = 'plugin.zip'): Promise<PluginSummary> {
  const form = new FormData()
  form.append('zip', zip, filename)
  return request<PluginSummary>(`${base}/api/plugins`, {
    method: 'POST',
    body: form,
  })
}
