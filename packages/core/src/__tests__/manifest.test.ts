import { describe, it, expect } from 'vitest'
import { validateManifest, MANIFEST_VERSION, MAX_ZIP_BYTES } from '../manifest.js'

const validManifest = {
  schemaVersion: 1,
  id: 'example-api',
  version: '1.0.0',
  title: 'Example API Plugin',
  halves: {
    browser: { entry: 'browser.jsx', pages: [{ path: '/example', title: 'Example' }] },
  },
}

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = validateManifest(validManifest)
    expect(m.id).toBe('example-api')
    expect(m.version).toBe('1.0.0')
  })

  it('rejects unknown schemaVersion', () => {
    expect(() => validateManifest({ ...validManifest, schemaVersion: 2 })).toThrow(/schemaVersion/)
  })

  it('rejects id with uppercase characters', () => {
    expect(() => validateManifest({ ...validManifest, id: 'Example' })).toThrow(/id/)
  })

  it('rejects non-semver version', () => {
    expect(() => validateManifest({ ...validManifest, version: '1.0' })).toThrow(/version/)
  })

  it('rejects empty halves', () => {
    expect(() => validateManifest({ ...validManifest, halves: {} })).toThrow(/halves/)
  })

  it('rejects page path not starting with /', () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        halves: { browser: { entry: 'b.jsx', pages: [{ path: 'noSlash', title: 'x' }] } },
      }),
    ).toThrow(/path/)
  })

  it('rejects additional top-level properties', () => {
    expect(() => validateManifest({ ...validManifest, extra: true })).toThrow()
  })

  it('accepts host + browser halves together', () => {
    const m = validateManifest({
      ...validManifest,
      halves: {
        host: { entry: 'host.ts' },
        browser: { entry: 'browser.tsx' },
      },
    })
    expect(m.halves.host?.entry).toBe('host.ts')
  })

  it('accepts pre-release versions', () => {
    const m = validateManifest({ ...validManifest, version: '1.0.0-rc.1' })
    expect(m.version).toBe('1.0.0-rc.1')
  })

  it('exports MANIFEST_VERSION = 1', () => {
    expect(MANIFEST_VERSION).toBe(1)
  })

  it('exports MAX_ZIP_BYTES = 4 MiB', () => {
    expect(MAX_ZIP_BYTES).toBe(4 * 1024 * 1024)
  })

  it('accepts a fullscreen page with plugin-owned routes', () => {
    const m = validateManifest({
      ...validManifest,
      halves: {
        browser: {
          entry: 'browser.js',
          pages: [
            {
              path: '/devctr',
              title: 'KV 控制台',
              layout: 'fullscreen',
              routes: [{ path: '/' }, { path: '/keys' }],
            },
          ],
        },
      },
    })
    const page = m.halves.browser?.pages?.[0]
    expect(page?.layout).toBe('fullscreen')
    expect(page?.routes).toEqual([{ path: '/' }, { path: '/keys' }])
  })

  it('rejects an unknown layout value', () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        halves: {
          browser: {
            entry: 'browser.js',
            pages: [{ path: '/x', title: 'X', layout: 'sidebar' }],
          },
        },
      }),
    ).toThrow(/layout/)
  })

  it('rejects a route path without a leading / (unless empty root)', () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        halves: {
          browser: {
            entry: 'browser.js',
            pages: [{ path: '/x', title: 'X', layout: 'fullscreen', routes: [{ path: 'keys' }] }],
          },
        },
      }),
    ).toThrow(/path/)
    // '' is the bare-prefix root route — valid.
    expect(() =>
      validateManifest({
        ...validManifest,
        halves: {
          browser: {
            entry: 'browser.js',
            pages: [{ path: '/x', title: 'X', layout: 'fullscreen', routes: [{ path: '' }] }],
          },
        },
      }),
    ).not.toThrow()
  })

  it('rejects extra properties on a route entry', () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        halves: {
          browser: {
            entry: 'browser.js',
            pages: [
              { path: '/x', title: 'X', layout: 'fullscreen', routes: [{ path: '/k', title: 'nope' }] },
            ],
          },
        },
      }),
    ).toThrow()
  })
})
