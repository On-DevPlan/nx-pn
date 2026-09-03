import { describe, it, expect } from 'vitest'
import { CordisContext } from '../cordis/cordis-shim.js'
import type { Context, Fiber } from '../cordis/cordis-shim.js'
import { Pages } from '../pages/pages-service.js'
import { activateBrowserHalf, retractBrowserHalf, type BrowserHalfRecord } from '../runner/browser-half-loader.js'

/** Install the Pages service and await its cordis activation. */
async function makeCtx(): Promise<Context> {
  const raw = new CordisContext() as Context
  await (raw.registry.plugin(Pages, {}) as unknown as Fiber).await()
  // Match what connectRpc does in the live browser: auditClient is also
  // a registered cordis service so fiber activation satisfies the
  // loader's `inject: ['pages', 'auditClient']` declaration. The test
  // halves only call `ctx.pages.register(...)` — the proxy itself can be
  // a no-op stub here.
  ;(raw.reflect as { provide: (name: string, value: unknown, check?: unknown) => unknown }).provide(
    'auditClient',
    { get: () => undefined, post: () => undefined, put: () => undefined, patch: () => undefined, delete: () => undefined },
    undefined,
  )
  return raw
}

interface RegisteredPage {
  pluginId: string
  path: string
  title: string
  order?: number
}

describe('activateBrowserHalf (spec §5.2.1 step 4)', () => {
  it('runs a half in its own fiber; pages.register lands and dispose removes it', async () => {
    const ctx = await makeCtx()

    // A half shaped exactly like plugins/example-api/browser.tsx.
    let registered: RegisteredPage | undefined
    function halfFn(pluginCtx: Context): void {
      const pages = pluginCtx.pages as unknown as { register(e: RegisteredPage): unknown }
      registered = { pluginId: 'example-api', path: '/example-api', title: '示例 API', order: 200 }
      pages.register(registered)
    }

    const record: BrowserHalfRecord = await activateBrowserHalf(
      { ctx },
      { id: 'example-api', pluginRunId: 'run-1' },
      halfFn,
    )
    expect(record.id).toBe('example-api')
    expect(record.pluginRunId).toBe('run-1')
    expect(record.fiber).toBeDefined()
    expect(record.fiber!.state).toBe(2) // ACTIVE

    const pages = ctx.pages as unknown as { getSnapshot(): readonly RegisteredPage[] }
    expect(pages.getSnapshot().map((e) => e.path)).toEqual(['/example-api'])
    expect(registered).toMatchObject({ pluginId: 'example-api', path: '/example-api', title: '示例 API' })

    // Retract → fiber disposed → effect-chain cleanup unregisters the page.
    await retractBrowserHalf({ ctx }, record)
    expect(record.fiber).toBeUndefined()
    expect(pages.getSnapshot()).toHaveLength(0)
  })

  it('a half that throws during apply rejects and leaves the context usable', async () => {
    const ctx = await makeCtx()
    function badHalf(): void {
      throw new Error('boom')
    }
    await expect(activateBrowserHalf({ ctx }, { id: 'bad', pluginRunId: 'run-2' }, badHalf)).rejects.toThrow(/boom/)

    // The failed half must not wedge the context: a good half still loads.
    const pages = ctx.pages as unknown as { getSnapshot(): readonly RegisteredPage[] }
    function goodHalf(pluginCtx: Context): void {
      ;(pluginCtx.pages as unknown as { register(e: RegisteredPage): unknown }).register({
        pluginId: 'ok',
        path: '/ok',
        title: 'OK',
      })
    }
    const record = await activateBrowserHalf({ ctx }, { id: 'ok', pluginRunId: 'run-3' }, goodHalf)
    expect(pages.getSnapshot().map((e) => e.path)).toEqual(['/ok'])
    await retractBrowserHalf({ ctx }, record)
  })
})
