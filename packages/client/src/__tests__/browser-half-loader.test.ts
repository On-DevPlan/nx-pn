import { describe, it, expect, vi, afterEach } from 'vitest'
import { CordisContext } from '../cordis/cordis-shim.js'
import type { Context, Fiber } from '../cordis/cordis-shim.js'
import { Pages } from '../pages/pages-service.js'
import { loadBrowserHalf, retractBrowserHalf, SHARED_BROWSER_EXTERNALS } from '../runner/browser-half-loader.js'

/** Install the Pages service and await its cordis activation. */
async function makeCtx(): Promise<Context> {
  const raw = new CordisContext() as Context
  await (raw.registry.plugin(Pages, {}) as unknown as Fiber).await()
  // Mirror the live browser: auditClient is a registered cordis service so
  // the loader's `inject: ['pages', 'auditClient']` is satisfied. Stub
  // methods are fine here — the test halves only touch ctx.pages.
  ;(raw.reflect as { provide: (name: string, value: unknown, check?: unknown) => unknown }).provide(
    'auditClient',
    { get: () => undefined, post: () => undefined, put: () => undefined, patch: () => undefined, delete: () => undefined },
    undefined,
  )
  // The loader's inject also declares `hostCall` (the browser→host
  // tool-event bridge) — stub it; the test halves never call it.
  ;(raw.reflect as { provide: (name: string, value: unknown, check?: unknown) => unknown }).provide(
    'hostCall',
    { hostCall: () => undefined },
    undefined,
  )
  return raw
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Node has no `import(blob:…)` support, so route URL.createObjectURL to a
 * data: URL carrying the same source. The dynamic-import + activate path is
 * otherwise exactly what the browser does (spec §5.2.1).
 */
function stubObjectUrls(source: string): void {
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf-8').toString('base64')}`
  vi.spyOn(URL, 'createObjectURL').mockReturnValue(dataUrl)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
}

interface PageRow {
  pluginId: string
  path: string
  title: string
  Component?: unknown
}

describe('loadBrowserHalf (spec §5.2.1 — blob import → activate)', () => {
  it('loads a small ESM half; pages.register (with Component) lands and dispose removes it', async () => {
    const source = `const half = (ctx) => {
      const Component = () => null
      ctx.pages.register({ pluginId: 'p', path: '/x', title: 'X', Component })
    }
export default half
`
    stubObjectUrls(source)

    const ctx = await makeCtx()
    const record = await loadBrowserHalf({ ctx }, { id: 'p', pluginRunId: 'run-1', code: source })
    expect(record.id).toBe('p')
    expect(record.pluginRunId).toBe('run-1')

    const pages = ctx.pages as unknown as { getSnapshot(): readonly PageRow[] }
    const snap = pages.getSnapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({ pluginId: 'p', path: '/x', title: 'X' })
    expect(snap[0]!.Component).toBeTypeOf('function')

    // Removing the half (plugin stopped) drops the page via the effect chain.
    await retractBrowserHalf({ ctx }, record)
    expect(pages.getSnapshot()).toHaveLength(0)
  })

  it('guards a half that lacks a default-exported function', async () => {
    stubObjectUrls('export const nope = 1')
    const ctx = await makeCtx()
    await expect(
      loadBrowserHalf({ ctx }, { id: 'bad', pluginRunId: 'run-2', code: 'export const nope = 1' }),
    ).rejects.toThrow(/default-export/)
  })

  it('loader declares inject:["pages"] so halves do not need to self-declare', async () => {
    // Regression test for the "cannot get property 'pages' without inject" bug:
    // the registration site (loader) must declare `inject: ['pages']` so a half
    // source that simply does `ctx.pages.register(...)` (without setting
    // `halfFn.inject = ['pages']` on itself) loads successfully against the real
    // cordis Context.
    const source = `const half = (ctx) => {
      const Component = () => null
      ctx.pages.register({ pluginId: 'opaque', path: '/opaque', title: 'Opaque', Component })
    }
export default half
`
    stubObjectUrls(source)

    const ctx = await makeCtx()
    const record = await loadBrowserHalf(
      { ctx },
      { id: 'opaque', pluginRunId: 'run-3', code: source },
    )
    expect(record.fiber).toBeDefined()

    const pages = ctx.pages as unknown as { getSnapshot(): readonly PageRow[] }
    const snap = pages.getSnapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({ pluginId: 'opaque', path: '/opaque', title: 'Opaque' })

    await retractBrowserHalf({ ctx }, record)
    expect(pages.getSnapshot()).toHaveLength(0)
  })

  it('documents the shared browser externals contract (spec §9.4 / §5.2.2)', () => {
    for (const spec of ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'react-router-dom']) {
      expect(SHARED_BROWSER_EXTERNALS).toContain(spec)
    }
  })
})