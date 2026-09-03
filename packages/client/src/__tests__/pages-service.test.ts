import { describe, it, expect, vi } from 'vitest'
import { Pages } from '../pages/pages-service.js'
import { CordisContext } from '../cordis/cordis-shim.js'
import type { Context, Fiber } from '../cordis/cordis-shim.js'
import { PageRegistry } from '../pages/page-registry.js'

/** Install the Pages service and await its cordis activation. */
async function makeCtx(): Promise<Context> {
  const raw = new CordisContext() as Context
  const fiber = raw.registry.plugin(Pages, {}) as unknown as Fiber
  await fiber.await()
  return raw
}

function pagesOf(ctx: Context): Pages {
  return ctx.pages as unknown as Pages
}

describe('Pages (cordis service, spec §5.3)', () => {
  it('register + getSnapshot round-trip via the cordis ctx', async () => {
    const ctx = await makeCtx()
    const pages = pagesOf(ctx)
    pages.register({ pluginId: 'p1', path: '/hello', title: 'Hello', order: 5 })
    const snap = pages.getSnapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({ pluginId: 'p1', path: '/hello', title: 'Hello', order: 5 })
  })

  it('register returns a disposer that removes exactly its own entry', async () => {
    const ctx = await makeCtx()
    const pages = pagesOf(ctx)
    const d1 = pages.register({ pluginId: 'p', path: '/a', title: 'A' })
    const d2 = pages.register({ pluginId: 'p', path: '/b', title: 'B' })
    d1()
    expect(pages.getSnapshot().map((e) => e.path)).toEqual(['/b'])
    d2()
    expect(pages.getSnapshot()).toHaveLength(0)
  })

  it('unregister removes all pages for a plugin', async () => {
    const ctx = await makeCtx()
    const pages = pagesOf(ctx)
    pages.register({ pluginId: 'p', path: '/a', title: 'A' })
    pages.register({ pluginId: 'p', path: '/b', title: 'B' })
    pages.register({ pluginId: 'q', path: '/q', title: 'Q' })
    pages.unregister('p')
    expect(pages.getSnapshot().map((e) => e.pluginId)).toEqual(['q'])
  })

  it('subscribe notifies on register', async () => {
    const ctx = await makeCtx()
    const pages = pagesOf(ctx)
    const cb = vi.fn()
    pages.subscribe(cb)
    pages.register({ pluginId: 'p', path: '/x', title: 'X' })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a plugin fiber that calls register is auto-cleaned when the fiber disposes', async () => {
    const ctx = new CordisContext() as Context
    await (ctx.registry.plugin(Pages, {}) as unknown as Fiber).await()
    // Browser-half plugin registers a page from inside its own fiber.
    // cordis reads `inject` / `name` off the plugin object, so an
    // object-form plugin (`{ name, inject, apply }`) declares its need
    // for `pages` and cordis activates only once it is available.
    const fiber = ctx.registry.plugin({
      name: 'demo',
      inject: ['pages'],
      apply(pluginCtx: Context): void {
        const pages = pluginCtx.pages as unknown as Pages
        pages.register({ pluginId: 'demo', path: '/demo', title: 'Demo' })
      },
    }) as unknown as Fiber
    await fiber.await()

    const pages = pagesOf(ctx)
    expect(pages.getSnapshot().map((e) => e.path)).toEqual(['/demo'])

    // Disposing the plugin fiber runs the effect disposers → page removed.
    await fiber.dispose()
    expect(pages.getSnapshot()).toHaveLength(0)
  })

  it('every ctx copy of the service shares one registry', async () => {
    const ctx = await makeCtx()
    const pages = pagesOf(ctx)
    pages.register({ pluginId: 'p', path: '/shared', title: 'Shared' })

    // An isolated ctx (plugin scope) resolves the same service store.
    const childCtx = ctx.extend({}) as Context
    const childPages = pagesOf(childCtx)
    childPages.register({ pluginId: 'p2', path: '/child', title: 'Child' })

    const snap = pages.getSnapshot()
    expect(snap).toHaveLength(2)
    expect(snap.map((e) => e.path).sort()).toEqual(['/child', '/shared'])
    expect((pages as { registry: PageRegistry }).registry).toBe(
      (childPages as { registry: PageRegistry }).registry,
    )
  })
})
