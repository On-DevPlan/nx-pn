/**
 * Maximum body bytes (after decompression) before truncation kicks in.
 * Spec §3.1: 1 MiB.
 */
export const MAX_BODY_BYTES = 1 * 1024 * 1024

export interface RequestConfig {
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Default 30_000; matches WS RPC default timeout (spec §3.1 / §4.5.2). */
  timeoutMs?: number
}

export interface AuditResponse {
  status: number
  statusText: string
  /** Decompressed headers (undici transparently decompresses; not wire headers). */
  headers: Record<string, string>
  /** Decompressed body byte count. */
  bytes: number
  truncated: boolean
  /**
   * Body as text. JSON bodies are JSON.parse → JSON.stringify so the diff view
   * is stable; otherwise utf-8 string. When `truncated`, only the first 4 KB.
   */
  bodyText: string
  /** Structured view when body parses as JSON AND not truncated. */
  bodyJson?: unknown
}

export interface AuditClient {
  get(url: string, config?: RequestConfig): Promise<AuditResponse>
  post(url: string, body?: BodyInit | unknown, config?: RequestConfig): Promise<AuditResponse>
  put(url: string, body?: BodyInit | unknown, config?: RequestConfig): Promise<AuditResponse>
  patch(url: string, body?: BodyInit | unknown, config?: RequestConfig): Promise<AuditResponse>
  delete(url: string, config?: RequestConfig): Promise<AuditResponse>
}
