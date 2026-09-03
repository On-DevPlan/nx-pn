import { describe, it, expect, vi, afterEach } from 'vitest'
import { CordisContext } from '../cordis/cordis-shim.js'
import type { Context, Fiber } from '../cordis/cordis-shim.js'
import { Pages } from '../pages/pages-service.js'
import { loadBrowserHalf, retractBrowserHalf, SHARED_BROWSER_EXTERNALS } from '../runner/browser-half-loader.js'

/** Install the Pages service and await its cordis activation. */
async function makeCtx(): Promise<Context> {
  const raw = new CordisContext() as Context
  await (raw.registry.plugin(Pages, {}) as unknown as Fiber).await()
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
    // cordis needs an explicit `inject: ['pages']` on the plugin value so it
    // doesn't try to access `ctx.pages` before the service is in scope.
    const source = `const half = (ctx) => {
      const Component = () => null
      ctx.pages.register({ pluginId: 'p', path: '/x', title: 'X', Component })
    }
half.inject = ['pages']
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

  it('documents the shared browser externals contract (spec §9.4 / §5.2.2)', () => {
    for (const spec of ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'react-router-dom']) {
      expect(SHARED_BROWSER_EXTERNALS).toContain(spec)
    }
  })
})