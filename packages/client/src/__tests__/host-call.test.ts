/**
 * HostCallService — the browser→host tool-event bridge service.
 *
 * Mirrors the AuditClientService contract: cordis binds `this.ctx` in
 * the prototype method to the *calling* fiber, so the service reads the
 * calling half's `pluginRunId` off its fiber config and attaches it to
 * the `tool.invoke` frame (host-side attribution logging).
 *
 * Cordis convention: services expose methods on the prototype, so the
 * call shape is `ctx.hostCall.hostCall(event, payload)` — matching
 * `ctx.auditClient.get(url)` and `ctx.pages.register(entry)`.
 *
 * Registration pattern matches prod (`installHostCall`): the service
 * runs on its own fiber via `ctx.registry.plugin(HostCallService, {})`
 * so child half-fibers can resolve it through the standard service
 * walk. Direct `new HostCallService(ctx)` (no fiber wrapper) registers
 * on the root only and is not resolvable from child fibers.
 */

import { describe, it, expect } from 'vitest'
import { CordisContext } from '../cordis/cordis-shim.js'
import type { Context, Fiber } from '../cordis/cordis-shim.js'
import { RpcClient } from '../rpc/rpc-client.js'
import { HostCallService, bindHostCallRpc } from '../host-call-service.js'

interface SentFrame {
  op: string
  generation: number
  requestId: string
  payload: { event?: string; payload?: unknown; pluginRunId?: string }
}

/** Real RpcClient over a capturing send; reset to generation 42. */
function makeRpc() {
  const sent: SentFrame[] = []
  const rpc = new RpcClient(
    (text) => {
      sent.push(JSON.parse(text) as SentFrame)
      return true
    },
    { defaultTimeoutMs: 200 },
  )
  rpc.reset(42)
  return { rpc, sent }
}

function replyOk(rpc: RpcClient, frame: SentFrame, data: unknown): void {
  rpc.handleFrame({
    v: 1,
    generation: frame.generation,
    requestId: frame.requestId,
    op: 'rpc.result',
    payload: { ok: true, data },
  })
}

/** installHostCall-equivalent: register the service on its own fiber and await it active. */
async function install(ctx: Context): Promise<void> {
  const fiber = ctx.registry.plugin(HostCallService, {}) as unknown as Fiber
  await (fiber.await as unknown as () => Promise<void>)()
}

/** Activate a plugin fiber whose apply calls the hostCall service. */
function callFromPluginFiber(
  ctx: Context,
  pluginRunId: string,
  run: (svc: { hostCall: (event: string, payload?: unknown) => Promise<unknown> }) => Promise<unknown>,
): Promise<unknown> {
  let result: Promise<unknown> = Promise.resolve()
  const fiber = ctx.registry.plugin(
    { inject: ['hostCall'], apply: (c: Context) => {
      const svc = c as unknown as { hostCall: (event: string, payload?: unknown) => Promise<unknown> }
      result = run(svc)
    } } as never,
    { name: 'half-under-test', pluginRunId },
  ) as unknown as Fiber
  const awaitFn = fiber.await as unknown as () => Promise<void>
  return awaitFn.call(fiber).then(() => result)
}

describe('HostCallService', () => {
  it('rejects before connectRpc binds the rpc client', async () => {
    const ctx = new CordisContext() as Context
    await install(ctx)
    const svc = ctx as unknown as { hostCall: { hostCall: (e: string, p?: unknown) => Promise<unknown> } }
    await expect(svc.hostCall.hostCall('x/y', {})).rejects.toThrow(/before connectRpc/)
  })

  it('forwards a tool.invoke frame with the calling fiber pluginRunId attached', async () => {
    const ctx = new CordisContext() as Context
    const { rpc, sent } = makeRpc()
    bindHostCallRpc(rpc)
    await install(ctx)

    const outcome = callFromPluginFiber(ctx, 'run-99', (svc) => svc.hostCall.hostCall('devctr-kv/login', { email: 'x' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sent).toHaveLength(1)
    const frame = sent[0]!
    expect(frame.op).toBe('tool.invoke')
    expect(frame.payload).toEqual({ event: 'devctr-kv/login', payload: { email: 'x' }, pluginRunId: 'run-99' })

    replyOk(rpc, frame, { ok: true, data: { token: 't' } })
    await expect(outcome).resolves.toEqual({ ok: true, data: { token: 't' } })
  })

  it('root / non-plugin callers carry an empty pluginRunId', async () => {
    const ctx = new CordisContext() as Context
    const { rpc, sent } = makeRpc()
    bindHostCallRpc(rpc)
    await install(ctx)

    const svc = ctx as unknown as { hostCall: { hostCall: (e: string, p?: unknown) => Promise<unknown> } }
    const p = svc.hostCall.hostCall('echo/ping', { v: 1 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sent[0]!.payload.pluginRunId).toBe('')
    replyOk(rpc, sent[0]!, { ok: true })
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('rejects locally on an empty event', async () => {
    const ctx = new CordisContext() as Context
    const { rpc, sent } = makeRpc()
    bindHostCallRpc(rpc)
    await install(ctx)
    const svc = ctx as unknown as { hostCall: { hostCall: (e: string) => Promise<unknown> } }
    await expect(svc.hostCall.hostCall('')).rejects.toThrow(/non-empty string/)
    expect(sent).toHaveLength(0)
  })

  it('propagates an rpc-level ok:false reply as a rejection', async () => {
    const ctx = new CordisContext() as Context
    const { rpc, sent } = makeRpc()
    bindHostCallRpc(rpc)
    await install(ctx)
    const svc = ctx as unknown as { hostCall: { hostCall: (e: string) => Promise<unknown> } }
    const p = svc.hostCall.hostCall('x/boom')
    await new Promise((resolve) => setTimeout(resolve, 10))
    rpc.handleFrame({
      v: 1,
      generation: sent[0]!.generation,
      requestId: sent[0]!.requestId,
      op: 'rpc.result',
      payload: { ok: false, error: { code: 'rpc/tool-error', message: 'handler exploded' } },
    })
    await expect(p).rejects.toMatchObject({ code: 'rpc/tool-error', message: 'handler exploded' })
  })
})