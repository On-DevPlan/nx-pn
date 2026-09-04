/**
 * HostCall service — browser-side cordis Service backing `ctx.hostCall`
 * for plugin browser halves: the browser→host tool-event bridge.
 *
 * A host half registers handlers on the HOST cordis context via
 * `ctx.on('<plugin>/<action>', handler)`; a browser half calls them with
 * `ctx.hostCall('<plugin>/<action>', payload)`. This service forwards
 * the call as a single `tool.invoke` WS RPC frame; the host dispatches
 * it with the result-returning cordis `serial` mode and replies with the
 * handler's payload (typically its ApiResult) inside `{ ok, data }`.
 *
 * Like AuditClientService, cordis binds `this.ctx` in the prototype
 * method to the *calling* fiber, so `this.ctx.fiber.config.pluginRunId`
 * is the half that made the call — every frame carries attribution
 * (logged by the host; never hard-fails on an unknown run id). Root /
 * non-plugin callers fall back to `''`.
 *
 * Prototype-method dispatch (not arrow class fields) per cordis's
 * convention — mirrors `audit-client-service.ts`.
 */

import { CordisService, type Context } from './cordis/cordis-shim.js'
import type { RpcClient } from './rpc/rpc-client.js'

/** Module-scoped RPC client, set by connectRpc when wiring the runtime. */
let currentRpc: RpcClient | undefined

/** Bind the WS RPC client used by every hostCall (connectRpc). */
export function bindHostCallRpc(rpc: RpcClient): void {
  currentRpc = rpc
}

export class HostCallService extends CordisService {
  static readonly service = 'hostCall'
  declare hostCall: (event: string, payload?: unknown) => Promise<unknown>

  constructor(ctx: Context) {
    super(ctx, 'hostCall')
  }
}

/** Recover the calling fiber's pluginRunId from the loader's fiber config. */
function callerPluginRunId(self: unknown): string {
  const fiber = (self as { ctx?: { fiber?: { config?: { pluginRunId?: unknown } } } }).ctx?.fiber
  const runId = fiber?.config?.pluginRunId
  return typeof runId === 'string' ? runId : ''
}

const hostCallProto = HostCallService.prototype as unknown as Record<string, unknown>

hostCallProto.hostCall = function (this: unknown, event: string, payload?: unknown): Promise<unknown> {
  const rpc = currentRpc
  if (!rpc) {
    return Promise.reject(new Error('hostCall used before connectRpc wired the RPC bridge'))
  }
  if (typeof event !== 'string' || !event) {
    return Promise.reject(new Error('hostCall: event must be a non-empty string'))
  }
  return rpc.invokeTool(event, payload, callerPluginRunId(this))
}
