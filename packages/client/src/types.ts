/**
 * Browser-side shape of a host audit record (spec §4.3). Type re-export
 * of the host record so the web shell and client package can consume it
 * without importing the Node-only host package.
 */

export interface AuditRecord {
  /** Monotonic id. */
  id: number
  /** Unix millis. */
  ts: number
  initiator: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  reqHeaders: Record<string, string>
  reqBody: { text: string; truncated: boolean; bytes: number }
  status: number
  statusText: string
  resHeaders: Record<string, string>
  resBody: { text: string; truncated: boolean; bytes: number; json?: unknown }
  durationMs: number
  replayOf?: number
  error?: { name: string; message: string }
}

/** core AuditResponse shape (mirrors @api-audit/core). */
export interface AuditResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  bytes: number
  truncated: boolean
  bodyText: string
  bodyJson?: unknown
}
