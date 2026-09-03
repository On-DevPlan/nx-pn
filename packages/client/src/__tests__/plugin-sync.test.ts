/**
 * `installBrowserHalfFromHost` — the REST-driven browser-half install path
 * the web shell uses on cold start and on plugin inventory changes
 * (spec §5.2.2 / last-mile wiring).
 *
 *   GET /api/plugins → plugin summaries
 *   GET /api/plugins/:runId/browser-source → compiled ESM
 *   loadBrowserHalf(source, ctx) → ctx.pages.register(...)
 *
 * Tests stub `URL.createObjectURL` to a `data:` URL (Node has no
 * `import(blob:…)` support) and stub `fetch` with a vi.fn returning the
 * `{ ok, data }` envelope the host serves.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { CordisContext } from '../cordis/cordis-shim.js'
import type { Context, Fiber } from '../cordis/cordis-shim.js'
import { Pages } from '../pages/pages-service.js'
import { installBrowserHalfFromHost } from '../runner/plugin-sync.js'

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
  return raw
}

/** Node has no `import(blob:…)`, so route URL.createObjectURL to a data URL. */
function stubObjectUrls(source: string): void {
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf-8').toString('base64')}`
  vi.spyOn(URL, 'createObjectURL').mockReturnValue(dataUrl)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
}

const HALF_SOURCE = `const half = (ctx) => {
  const Component = () => null
  ctx.pages.register({ pluginId: 'example-api', path: '/example-api', title: '示例 API', Component })
}
half.inject = ['pages']
export default half
`

function pluginListEnvelope(pluginId: string, hasBrowser: boolean): unknown {
  return {
    ok: true,
    data: [
      {
        id: pluginId,
        pluginRunId: 'run-1',
        manifest: {
          schemaVersion: 1,
          id: pluginId,
          version: '1.0.0',
          title: 'Test',
          halves: hasBrowser
            ? { host: { entry: 'host.js' }, browser: { entry: 'browser.js' } }
            : { host: { entry: 'host.js' } },
        },
      },
    ],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('installBrowserHalfFromHost (last-mile wiring)', () => {
  it('fetches the plugin list, then browser-source, and registers the page', async () => {
    stubObjectUrls(HALF_SOURCE)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(pluginListEnvelope('example-api', true)),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(HALF_SOURCE),
      })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const ctx = await makeCtx()
    const record = await installBrowserHalfFromHost({ ctx }, { id: 'example-api' })

    expect(record).toBeDefined()
    expect(record!.id).toBe('example-api')
    expect(record!.pluginRunId).toBe('run-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/plugins')
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/api/plugins/run-1/browser-source')

    const pages = ctx.pages as unknown as {
      getSnapshot(): readonly { pluginId: string; path: string; title: string; Component?: unknown }[]
    }
    const snap = pages.getSnapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({ pluginId: 'example-api', path: '/example-api', title: '示例 API' })
    expect(typeof snap[0]!.Component).toBe('function')
  })

  it('returns undefined and skips the browser-source fetch when the plugin has no browser half', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(pluginListEnvelope('host-only', false)),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const ctx = await makeCtx()
    const record = await installBrowserHalfFromHost({ ctx }, { id: 'host-only' })

    expect(record).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns undefined when the plugin is not in the list', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, data: [] }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const ctx = await makeCtx()
    const record = await installBrowserHalfFromHost({ ctx }, { id: 'missing' })

    expect(record).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('calling twice for the same plugin is idempotent (upsert, no duplicate fiber crash)', async () => {
    stubObjectUrls(HALF_SOURCE)
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(pluginListEnvelope('example-api', true)),
        text: () => Promise.resolve(HALF_SOURCE),
      })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const ctx = await makeCtx()
    const r1 = await installBrowserHalfFromHost({ ctx }, { id: 'example-api' })
    const r2 = await installBrowserHalfFromHost({ ctx }, { id: 'example-api' })

    expect(r1).toBeDefined()
    expect(r2).toBeDefined()

    const pages = ctx.pages as unknown as { getSnapshot(): readonly { pluginId: string; path: string }[] }
    // PageRegistry.register upserts on (pluginId, path) → exactly one entry.
    const snap = pages.getSnapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({ pluginId: 'example-api', path: '/example-api' })
  })
})
