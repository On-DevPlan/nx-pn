/**
 * AuditClient service — browser-side cordis Service backing
 * `ctx.auditClient` for plugin browser halves (spec §5.5).
 *
 * Every browser half may call `ctx.auditClient.get/post/put/patch/delete`
 * inside its apply (or captured component). cordis binds `this.ctx` in
 * the prototype methods to the *calling* fiber, so `this.ctx.fiber` is
 * the half that made the call. The loader passes each half's
 * `pluginRunId` in the fiber config; this service reads it back and
 * forwards a single `rpc.invoke` frame over the WS bridge. The host
 * resolves the runId to the manifest name and attributes the audit row
 * (spec §7.4). Root / non-plugin callers have no config.pluginRunId and
 * fall back to `''` (host attributes to "core").
 *
 * Prototype-method dispatch (not arrow class fields) per cordis's
 * convention — mirrors `pages-service.ts` and the host's
 * `AuditClientService`.
 */

import { CordisService, type Context } from '../cordis/cordis-shim.js'
import type { RpcClient } from '../rpc/rpc-client.js'
import { parseResponse } from './client-proxy.js'

type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Module-scoped RPC client, set by connectRpc when wiring the runtime. */
let currentRpc: RpcClient | undefined

/** Bind the WS RPC client used by every auditClient method (connectRpc). */
export function bindAuditRpc(rpc: RpcClient): void {
  currentRpc = rpc
}

export class AuditClientService extends CordisService {
  static readonly service = 'auditClient'
  declare get: (url: string, config?: Record<string, unknown>) => Promise<unknown>
  declare post: (url: string, body?: unknown, config?: Record<string, unknown>) => Promise<unknown>
  declare put: (url: string, body?: unknown, config?: Record<string, unknown>) => Promise<unknown>
  declare patch: (url: string, body?: unknown, config?: Record<string, unknown>) => Promise<unknown>
  declare delete: (url: string, config?: Record<string, unknown>) => Promise<unknown>

  constructor(ctx: Context) {
    super(ctx, 'auditClient')
  }
}

/** Recover the calling fiber's pluginRunId from the loader's fiber config. */
function callerPluginRunId(self: unknown): string {
  const fiber = (self as { ctx?: { fiber?: { config?: { pluginRunId?: unknown } } } }).ctx?.fiber
  const runId = fiber?.config?.pluginRunId
  return typeof runId === 'string' ? runId : ''
}

function invoke(self: unknown, verb: HttpVerb, url: string, body?: unknown, config?: Record<string, unknown>): Promise<unknown> {
  const rpc = currentRpc
  if (!rpc) {
    return Promise.reject(new Error('auditClient used before connectRpc wired the RPC bridge'))
  }
  return rpc.request('rpc.invoke', {
    method: verb,
    url,
    ...(body !== undefined ? { body } : {}),
    ...(config ? { config } : {}),
    pluginRunId: callerPluginRunId(self),
  } as never).then((data) => parseResponse(data))
}

const auditClientProto = AuditClientService.prototype as unknown as Record<string, unknown>
auditClientProto.get = function (this: unknown, url: string, config?: Record<string, unknown>) {
  return invoke(this, 'GET', url, undefined, config)
}
auditClientProto.post = function (this: unknown, url: string, body?: unknown, config?: Record<string, unknown>) {
  return invoke(this, 'POST', url, body, config)
}
auditClientProto.put = function (this: unknown, url: string, body?: unknown, config?: Record<string, unknown>) {
  return invoke(this, 'PUT', url, body, config)
}
auditClientProto.patch = function (this: unknown, url: string, body?: unknown, config?: Record<string, unknown>) {
  return invoke(this, 'PATCH', url, body, config)
}
auditClientProto.delete = function (this: unknown, url: string, config?: Record<string, unknown>) {
  return invoke(this, 'DELETE', url, undefined, config)
}