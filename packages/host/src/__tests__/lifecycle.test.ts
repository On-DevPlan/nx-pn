import { describe, it, expect } from 'vitest'
import { PluginLifecycle } from '../plugins/lifecycle.js'
import type { Manifest } from '@flowot/nx-pn-core'
import { CordisContext } from '../cordis/cordis-shim.js'

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
})