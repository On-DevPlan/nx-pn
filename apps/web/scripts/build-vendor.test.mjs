/**
 * apps/web/scripts/build-vendor.test.mjs
 *
 * Smoke tests for `build-vendor.mjs`:
 *
 *   1. The script runs to completion and produces every vendor file
 *      with a real static ESM `export { … }` block.
 *   2. The expected named exports are present in each bundle's
 *      export block (regression for the rollup "only default"
 *      collapse bug and the esbuild `__reExport` / `__require`
 *      fallbacks that produced non-functional browser bundles).
 *   3. The `__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`
 *      dispatcher marker is bundled into the React core vendor —
 *      proves the bundled code is the real React internals.
 *   4. The node-side import smoke resolves `react-router-dom.js`
 *      and exposes both `Link` and `useNavigate` as named exports.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url))) // apps/web/
const outDir = join(root, 'public', 'vendor')
const scriptPath = join(root, 'scripts', 'build-vendor.mjs')

/**
 * @typedef {object} VendorSpec
 * @property {string} file
 * @property {string[]} required - Names that MUST appear in the `export { … }` block.
 * @property {boolean} [expectInternals] - True iff the bundle should carry the React dispatcher marker.
 */

/** @type {VendorSpec[]} */
const SPECS = [
  {
    file: 'react.js',
    required: ['Children', 'Component', 'Fragment', 'useState', 'createElement', 'version'],
    expectInternals: true,
  },
  {
    file: 'react-jsx-runtime.js',
    required: ['Fragment', 'jsx', 'jsxs'],
  },
  {
    file: 'react-dom.js',
    required: ['createPortal', 'createRoot', 'hydrateRoot', 'version'],
    expectInternals: true,
  },
  {
    file: 'react-dom-client.js',
    required: ['createRoot', 'hydrateRoot'],
  },
  {
    file: 'react-router-dom.js',
    required: ['BrowserRouter', 'Link', 'NavLink', 'useNavigate', 'useParams'],
  },
]

describe('build-vendor.mjs', () => {
  beforeAll(async () => {
    // The script writes its own ESM entries under scripts/vendor-input/
    // and rewrites every file in public/vendor/. Run it once at the
    // top of the suite so subsequent assertions read a fresh build.
    const res = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    if (res.status !== 0) {
      throw new Error(
        `build-vendor.mjs failed (exit ${res.status})\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
      )
    }
  }, 60_000)

  it('produces every vendor file with non-empty content', async () => {
    for (const spec of SPECS) {
      const path = join(outDir, spec.file)
      expect(existsSync(path), `${spec.file} was not produced`).toBe(true)
      const text = await readFile(path, 'utf-8')
      expect(text.length, `${spec.file} is empty`).toBeGreaterThan(0)
    }
  })

  for (const spec of SPECS) {
    describe(`${spec.file} exports`, () => {
      it('emits a real static `export { … }` block (not a default-only collapse)', async () => {
        const text = await readFile(join(outDir, spec.file), 'utf-8')
        // An empty export block `{ }` would still satisfy this regex —
        // assert there are actual named bindings after the opening brace.
        const blockMatch = text.match(/^export\s*\{([^}]+)\}/m)
        expect(blockMatch, `${spec.file} has no export block`).not.toBeNull()
        const body = blockMatch ? blockMatch[1] : ''
        expect(body.trim().length, `${spec.file} export block is empty`).toBeGreaterThan(0)
      })

      it('exposes every required named export', async () => {
        const text = await readFile(join(outDir, spec.file), 'utf-8')
        const blockMatch = text.match(/^export\s*\{[^}]*\}/m)
        const block = blockMatch ? blockMatch[0] : ''
        for (const name of spec.required) {
          // Word-boundary match — avoids false positives where a
          // substring of one name shadows another (e.g. `use` in
          // `useState`).
          const re = new RegExp(`\\b${name}\\b`)
          expect(re.test(block), `${spec.file} missing required export "${name}"`).toBe(true)
        }
      })

      if (spec.expectInternals) {
        it('carries the React dispatcher marker (real internals, not a stub)', async () => {
          const text = await readFile(join(outDir, spec.file), 'utf-8')
          expect(
            text.includes('__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED'),
            `${spec.file} missing __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`,
          ).toBe(true)
        })
      }

      it('does not fall back to the esbuild runtime-require helper (browser-incompatible)', async () => {
        const text = await readFile(join(outDir, spec.file), 'utf-8')
        expect(
          text.includes('__require('),
          `${spec.file} contains __require — esbuild-style runtime require, fails in browsers`,
        ).toBe(false)
        expect(
          /Dynamic require of/.test(text),
          `${spec.file} carries the esbuild "Dynamic require not supported" shim`,
        ).toBe(false)
      })
    })
  }

  it('react-router-dom.js loads in Node and exposes Link + useNavigate', async () => {
    // Importing the vendor file in Node resolves the bare-specifier
    // imports (`react`, `react-dom`) via walk-up from public/vendor/
    // into apps/web/node_modules — the same resolution the browser
    // gets via the import map.
    const rrdPath = new URL('../public/vendor/react-router-dom.js', import.meta.url).href
    const mod = await import(rrdPath)
    expect(typeof mod, 'react-router-dom.js did not load as a module').toBe('object')
    expect('Link' in mod, 'react-router-dom.js missing named export "Link"').toBe(true)
    expect('useNavigate' in mod, 'react-router-dom.js missing named export "useNavigate"').toBe(true)
  })

  it('react.js loads in Node and exposes useState (default-import path)', async () => {
    const reactPath = new URL('../public/vendor/react.js', import.meta.url).href
    const mod = await import(reactPath)
    expect('useState' in mod, 'react.js missing named export "useState"').toBe(true)
    // CJS modules always have a default export (the module.exports
    // namespace) so consumers can `import React from 'react'`.
    expect('default' in mod, 'react.js missing default export (CJS interop)').toBe(true)
  })
})
