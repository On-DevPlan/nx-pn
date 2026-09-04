import { describe, it, expect } from 'vitest'
import { PluginLifecycle, type LifecycleEntry } from '../plugins/lifecycle.js'
import type { Manifest } from '@flowot/nx-pn-core'
import { CordisContext } from '../cordis/cordis-shim.js'
import type { BrowserHalfPusher } from '../ws/browser-half-pusher.js'

function fakeManifest(): Manifest {
  return {
    schemaVersion: 1,
    id: 'myplug',
    version: '1.0.0',
    title: 'My Plugin',
    halves: { host: { entry: 'host.js' } },
  }
}

function fakeFiber(ctx: Context): { fiber: import('cordis').Fiber } {
  // Use a no-op plugin and grab the resulting fiber.
  const fiber = ctx.registry.plugin(() => undefined, { name: 'test' })
  return { fiber }
}

/** Capture every retract call without needing a real WsHostServer. */
function makeSpyPusher(): BrowserHalfPusher & { retracts: Array<{ pluginRunId: string; id?: string }> } {
  const retracts: Array<{ pluginRunId: string; id?: string }> = []
  return {
    load: () => false,
    retract: (pluginRunId: string, id?: string) => {
      retracts.push(id !== undefined ? { pluginRunId, id } : { pluginRunId })
    },
    retracts,
  } as unknown as BrowserHalfPusher & { retracts: Array<{ pluginRunId: string; id?: string }> }
}

describe('PluginLifecycle', () => {
  it('register + list + byRunId', () => {
    const lc = new PluginLifecycle()
    const ctx = new CordisContext()
    const { fiber } = fakeFiber(ctx)
    lc.register({ id: 'p1', pluginRunId: 'r1', fiber, manifest: fakeManifest() })
    expect(lc.list()).toHaveLength(1)
    expect(lc.byRunId('r1')?.id).toBe('p1')
    expect(lc.byRunId('nonexistent')).toBeUndefined()
  })

  it('nextRunId is monotonic', () => {
    const lc = new PluginLifecycle()
    const a = lc.nextRunId()
    const b = lc.nextRunId()
    const c = lc.nextRunId()
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
  })

  it('stop is idempotent', async () => {
    const lc = new PluginLifecycle()
    const ctx = new CordisContext()
    const { fiber } = fakeFiber(ctx)
    lc.register({ id: 'p', pluginRunId: 'r', fiber, manifest: fakeManifest() })
    await lc.stop('r')
    // calling twice must not throw
    await lc.stop('r')
    expect(lc.byRunId('r')?.fiber).toBeDefined() // entry stays until remove
  })

  it('remove disposes and evicts', async () => {
    const lc = new PluginLifecycle()
    const ctx = new CordisContext()
    const { fiber } = fakeFiber(ctx)
    lc.register({ id: 'p', pluginRunId: 'r', fiber, manifest: fakeManifest() })
    await lc.remove('r')
    expect(lc.byRunId('r')).toBeUndefined()
    expect(lc.list()).toHaveLength(0)
  })

  it('stopAll disposes everything', async () => {
    const lc = new PluginLifecycle()
    const ctx = new CordisContext()
    const a = ctx.registry.plugin(() => undefined, { name: 'a' })
    const b = ctx.registry.plugin(() => undefined, { name: 'b' })
    lc.register({ id: 'a', pluginRunId: 'r1', fiber: a, manifest: fakeManifest() })
    lc.register({ id: 'b', pluginRunId: 'r2', fiber: b, manifest: fakeManifest() })
    await lc.stopAll()
    expect(lc.list()).toHaveLength(2) // entries stay; disposal just stops them
  })

  it('listById returns only entries with the matching manifest id', () => {
    const lc = new PluginLifecycle()
    const ctx = new CordisContext()
    const fa = ctx.registry.plugin(() => undefined, { name: 'a' })
    const fb = ctx.registry.plugin(() => undefined, { name: 'b' })
    lc.register({ id: 'foo', pluginRunId: 'r1', fiber: fa, manifest: { ...fakeManifest(), id: 'foo' } })
    lc.register({ id: 'foo', pluginRunId: 'r2', fiber: fb, manifest: { ...fakeManifest(), id: 'foo' } })
    lc.register({ id: 'bar', pluginRunId: 'r3', fiber: ctx.registry.plugin(() => undefined, { name: 'c' }), manifest: { ...fakeManifest(), id: 'bar' } })
    expect(lc.listById('foo').map((e) => e.pluginRunId).sort()).toEqual(['r1', 'r2'])
    expect(lc.listById('bar').map((e) => e.pluginRunId)).toEqual(['r3'])
    expect(lc.listById('nope')).toEqual([])
  })

  it('remove broadcasts browser-half.retract when a pusher is wired', async () => {
    const lc = new PluginLifecycle()
    const ctx = new CordisContext()
    const { fiber } = fakeFiber(ctx)
    const entry: LifecycleEntry = { id: 'plug-id', pluginRunId: 'r-x', fiber, manifest: fakeManifest() }
    lc.register(entry)
    const spy = makeSpyPusher()
    lc.setBrowserHalfPusher(spy)
    await lc.remove('r-x')
    expect(lc.byRunId('r-x')).toBeUndefined()
    // The retract frame MUST carry the manifest id so the client can
    // unregister pages even when the pluginRunId is gone after a re-upload.
    expect(spy.retracts).toEqual([{ pluginRunId: 'r-x', id: 'plug-id' }])
  })

  it('remove without a pusher does not throw (legacy tests / direct use)', async () => {
    const lc = new PluginLifecycle()
    const ctx = new CordisContext()
    const { fiber } = fakeFiber(ctx)
    lc.register({ id: 'p', pluginRunId: 'r', fiber, manifest: fakeManifest() })
    // No setBrowserHalfPusher call → remove must still dispose + evict.
    await lc.remove('r')
    expect(lc.byRunId('r')).toBeUndefined()
  })
})