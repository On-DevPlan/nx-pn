/**
 * Host audit record schema — persisted to ring buffer and pushed over WS.
 * Spec §4.3.
 */
export interface AuditRecord {
  /** Monotonic id (auto-assigned by ring buffer). */
  id: number
  /** Unix millis. */
  ts: number
  initiator: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  /** Already-redacted request headers. */
  reqHeaders: Record<string, string>
  /** Request body (post-credential-redaction). */
  reqBody: { text: string; truncated: boolean; bytes: number }
  /** 0 if network error. */
  status: number
  statusText: string
  /** Decompressed response headers. */
  resHeaders: Record<string, string>
  resBody: { text: string; truncated: boolean; bytes: number; json?: unknown }
  durationMs: number
  /** Set when triggered by /api/replay. */
  replayOf?: number
  /** Network/runtime error. */
  error?: { name: string; message: string }
}