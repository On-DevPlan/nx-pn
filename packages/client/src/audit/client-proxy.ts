/**
 * AuditClient proxy — WS RPC broker for plugin-initiated requests.
 * Spec §5.5.
 *
 * Each proxy binds a `pluginRunId` at construction (the runner injects
 * it when loading a browser half) so every forwarded request carries the
 * caller's run id. The host side rejects invocations whose pluginRunId
 * no longer matches the lifecycle registry (`stale-run`); the proxy
 * translates transport errors into local `Error`s.
 */

import type { AuditClient, AuditResponse, RequestConfig } from '@api-audit/core'
import type { RpcClient } from '../rpc/rpc-client.js'

export interface ClientProxyOptions {
  /** Current pluginRunId the proxy speaks for (updates on reload). */
  pluginRunId: string
}

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** Minimal method-verb shape accepted by the host request bridge. */
type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Browser-side AuditClient implementation. Every method forwards a
 * single `rpc.invoke` round-trip to the host:
 *
 *   { method, url, body?, pluginRunId, config? }
 */
export class ClientAuditClientProxy implements AuditClient {
  private readonly rpc: RpcClient
  private pluginRunId: string

  constructor(rpc: RpcClient, opts: ClientProxyOptions) {
    this.rpc = rpc
    this.pluginRunId = opts.pluginRunId
  }

  /** Re-bind to a new run id after a plugin reload. */
  setPluginRunId(pluginRunId: string): void {
    this.pluginRunId = pluginRunId
  }

  /** @internal test introspection: the underlying RpcClient. */
  rpcRef(): RpcClient {
    return this.rpc
  }

  get(url: string, config?: RequestConfig): Promise<AuditResponse> {
    return this.invoke('GET', url, undefined, config)
  }

  post(url: string, body?: unknown, config?: RequestConfig): Promise<AuditResponse> {
    return this.invoke('POST', url, body, config)
  }

  put(url: string, body?: unknown, config?: RequestConfig): Promise<AuditResponse> {
    return this.invoke('PUT', url, body, config)
  }

  patch(url: string, body?: unknown, config?: RequestConfig): Promise<AuditResponse> {
    return this.invoke('PATCH', url, body, config)
  }

  delete(url: string, config?: RequestConfig): Promise<AuditResponse> {
    return this.invoke('DELETE', url, undefined, config)
  }

  private async invoke(verb: HttpVerb, url: string, body: unknown, config?: RequestConfig): Promise<AuditResponse> {
    const data = await this.rpc.request('rpc.invoke', {
      method: verb,
      url,
      ...(body !== undefined ? { body } : {}),
      ...(config ? { config } : {}),
      pluginRunId: this.pluginRunId,
    } as never)
    return parseResponse(data)
  }
}

/** Validate the host's response payload into an AuditResponse. */
export function parseResponse(data: unknown): AuditResponse {
  if (!data || typeof data !== 'object') {
    throw new RpcError('malformed audit response')
  }
  const d = data as Partial<AuditResponse>
  return {
    status: d.status ?? 0,
    statusText: d.statusText ?? '',
    headers: d.headers ?? {},
    bytes: d.bytes ?? 0,
    truncated: d.truncated ?? false,
    bodyText: d.bodyText ?? '',
    ...(d.bodyJson !== undefined ? { bodyJson: d.bodyJson } : {}),
  }
}
