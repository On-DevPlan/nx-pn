/**
 * apps/web/scripts/build-vendor.mjs
 *
 * Build standalone ESM bundles for the shared React stack into
 * `apps/web/public/vendor/`. The web dist imports these via an
 * import map (index.html) so the web shell AND every loaded
 * plugin browser half resolve `react`, `react-dom`,
 * `react/jsx-runtime`, `react-dom/client`, `react-router-dom` to the
 * SAME module instances — "Exactly one React" (spec §5.2.2).
 *
 *   `vite build` copies `public/**` → `dist/**`, so the import map
 *   resolves `/vendor/<name>.js` from `dist/vendor/<name>.js` in
 *   production.
 *
 * Why rollup (not esbuild):
 *   esbuild's `export * from "react"` falls back to a runtime
 *   `__reExport` helper when the imported package is CJS (React is
 *   CJS), which produces a bundle with no observable ESM `export`
 *   statements — the browser sees an empty namespace and
 *   `import { useState } from 'react'` resolves to undefined.
 *   Rollup + `@rollup/plugin-commonjs` enumerates the CJS exports via
 *   cjs-module-lexer and emits them as proper static ESM exports.
 */

import { rollup } from 'rollup'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url))) // apps/web/
const outDir = join(root, 'public', 'vendor')
await mkdir(outDir, { recursive: true })

/**
 * @type {{ name: string; pkg: string; external: string[] }[]}
 *
 * `external` per entry: every shared dep the entry internally
 * imports must be externalised to its sibling vendor bundle so the
 * final stack is a single React instance. e.g. `react-dom/client`
 * internally `require('react')` — externalise `react` so it
 * resolves to `vendor/react.js` at runtime.
 */
const vendors = [
  { name: 'react.js', pkg: 'react', external: [] },
  { name: 'react-jsx-runtime.js', pkg: 'react/jsx-runtime', external: ['react'] },
  { name: 'react-dom.js', pkg: 'react-dom', external: ['react'] },
  { name: 'react-dom-client.js', pkg: 'react-dom/client', external: ['react'] },
  { name: 'react-router-dom.js', pkg: 'react-router-dom', external: ['react', 'react-dom'] },
]

for (const v of vendors) {
  const bundle = await rollup({
    input: v.pkg,
    external: v.external,
    plugins: [
      nodeResolve({ preferBuiltins: false, extensions: ['.js', '.jsx', '.mjs', '.cjs'] }),
      commonjs({
        transformMixedEsModules: true,
        defaultIsModuleExports: 'auto',
        requireReturnsDefault: 'auto',
        extensions: ['.js', '.cjs'],
      }),
    ],
    onwarn(warning, defaultHandler) {
      // Silence the noisy "preferConst" / "this is undefined" hints from
      // React's development source — they are not actionable here.
      if (warning.code === 'THIS_IS_UNDEFINED' || warning.code === 'PREFER_CONST') return
      if (warning.code === 'CIRCULAR_DEPENDENCY' && /node_modules/.test(warning.message ?? '')) return
      defaultHandler(warning)
    },
  })
  const { output } = await bundle.generate({
    format: 'es',
    inlineDynamicImports: false,
  })
  const chunk = output[0]
  if (!chunk) throw new Error(`build-vendor: no output chunk for ${v.name}`)
  const text = typeof chunk.code === 'string' ? chunk.code : ''
  if (!text) throw new Error(`build-vendor: empty output for ${v.name}`)
  await writeFile(join(outDir, v.name), text, 'utf-8')

  // Smoke: every bundle must contain an ESM export statement
  // (proves rollup emitted real named exports — not a CJS facade
  // with a hidden namespace).
  if (!/^\s*export\s/m.test(text)) {
    throw new Error(`build-vendor: ${v.name} contains no "export" statement`)
  }
  // React / ReactDOM bundles must carry the dispatcher marker — proves
  // the bundled code is the real React internals (not an accidental
  // stub from a missing export resolution).
  const expectInternals = v.pkg === 'react' || v.pkg.startsWith('react/')
  if (expectInternals && !/__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED/.test(text)) {
    throw new Error(`build-vendor: ${v.name} missing react internals marker`)
  }
  console.log(`vendor ${v.name}: ${text.length} bytes (${output.length} chunks)`)
}

// Import smoke: load the most complex bundle (react-router-dom — it
// imports react + react-dom externally and re-exports both router +
// dom helpers) in node and confirm it resolves as a real module with
// named exports. apps/web/node_modules carries the real React stack
// so Node's ESM resolution finds the externalised imports via
// walk-up from the vendor dir.
const rrdPath = new URL(`../public/vendor/react-router-dom.js`, import.meta.url)
const rrdMod = await import(rrdPath.href)
if (!rrdMod || typeof rrdMod !== 'object') {
  throw new Error(`build-vendor: react-router-dom.js did not load as a module`)
}
// Link is a forwardRef (object), useNavigate is a function — accept either
// type as long as the named export exists.
if (!('Link' in rrdMod) || !('useNavigate' in rrdMod)) {
  throw new Error(
    `build-vendor: react-router-dom.js missing named exports (got ${Object.keys(rrdMod).slice(0, 6).join(',')}…)`,
  )
}
console.log('vendor import smoke ok (Link + useNavigate present)')