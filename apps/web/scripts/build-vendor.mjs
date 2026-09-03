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
 *   esbuild's `format: 'esm'` keeps CJS `require()` calls as a
 *   runtime `__require` helper when the target module is marked
 *   `external`. In the browser that helper throws "Dynamic require
 *   of X is not supported" — the bundle fails to load.
 *   Rollup + `@rollup/plugin-commonjs` uses cjs-module-lexer to
 *   statically enumerate React's named exports AND rewrites CJS
 *   `require('react')` calls to ESM `import 'react'` so the
 *   externalised specifiers resolve through the web shell's import
 *   map. The output is a single, browser-ready ESM bundle with real
 *   named exports.
 *
 *   For each vendor we write a tiny ESM entry under
 *   `scripts/vendor-input/<name>.mjs` that does `export { … } from
 *   '<pkg>'` with the explicit known named-export list — that lets
 *   the commonjs plugin trace the CJS exports precisely.
 */

import { rollup } from 'rollup'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url))) // apps/web/
const outDir = join(root, 'public', 'vendor')
const inputDir = join(root, 'scripts', 'vendor-input')
await mkdir(outDir, { recursive: true })
await mkdir(inputDir, { recursive: true })

/**
 * The public surface of each vendor package, as explicit named
 * re-exports. These are the names rollup will emit as static
 * `export { … }` in the output.
 *
 * Source of truth: `Object.keys(require('<pkg>'))` for the matching
 * version pinned in apps/web/package.json. Update these lists when
 * the dependency version bumps.
 */
const REACT_EXPORTS = [
  'Children',
  'Component',
  'Fragment',
  'Profiler',
  'PureComponent',
  'StrictMode',
  'Suspense',
  'act',
  'cloneElement',
  'createContext',
  'createElement',
  'createFactory',
  'createRef',
  'forwardRef',
  'isValidElement',
  'lazy',
  'memo',
  'startTransition',
  'unstable_act',
  'useCallback',
  'useContext',
  'useDebugValue',
  'useDeferredValue',
  'useEffect',
  'useId',
  'useImperativeHandle',
  'useInsertionEffect',
  'useLayoutEffect',
  'useMemo',
  'useReducer',
  'useRef',
  'useState',
  'useSyncExternalStore',
  'useTransition',
  'version',
]
const REACT_JSX_RUNTIME_EXPORTS = ['Fragment', 'jsx', 'jsxs']
const REACT_DOM_EXPORTS = [
  'createPortal',
  'createRoot',
  'findDOMNode',
  'flushSync',
  'hydrate',
  'hydrateRoot',
  'render',
  'unmountComponentAtNode',
  'unstable_batchedUpdates',
  'unstable_renderSubtreeIntoContainer',
  'version',
]
const REACT_DOM_CLIENT_EXPORTS = ['createRoot', 'hydrateRoot']
const REACT_ROUTER_DOM_EXPORTS = [
  'AbortedDeferredError',
  'Await',
  'BrowserRouter',
  'Form',
  'HashRouter',
  'Link',
  'MemoryRouter',
  'NavLink',
  'Navigate',
  'NavigationType',
  'Outlet',
  'Route',
  'Router',
  'RouterProvider',
  'Routes',
  'ScrollRestoration',
  'UNSAFE_DataRouterContext',
  'UNSAFE_DataRouterStateContext',
  'UNSAFE_ErrorResponseImpl',
  'UNSAFE_FetchersContext',
  'UNSAFE_LocationContext',
  'UNSAFE_NavigationContext',
  'UNSAFE_RouteContext',
  'UNSAFE_ViewTransitionContext',
  'UNSAFE_useRouteId',
  'UNSAFE_useScrollRestoration',
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
  'createPath',
  'createRoutesFromChildren',
  'createRoutesFromElements',
  'createSearchParams',
  'defer',
  'generatePath',
  'isRouteErrorResponse',
  'json',
  'matchPath',
  'matchRoutes',
  'parsePath',
  'redirect',
  'redirectDocument',
  'renderMatches',
  'replace',
  'resolvePath',
  'unstable_HistoryRouter',
  'unstable_usePrompt',
  'useActionData',
  'useAsyncError',
  'useAsyncValue',
  'useBeforeUnload',
  'useBlocker',
  'useFetcher',
  'useFetchers',
  'useFormAction',
  'useHref',
  'useInRouterContext',
  'useLinkClickHandler',
  'useLoaderData',
  'useLocation',
  'useMatch',
  'useMatches',
  'useNavigate',
  'useNavigation',
  'useNavigationType',
  'useOutlet',
  'useOutletContext',
  'useParams',
  'useResolvedPath',
  'useRevalidator',
  'useRouteError',
  'useRouteLoaderData',
  'useRoutes',
  'useSearchParams',
  'useSubmit',
  'useViewTransitionState',
]

/**
 * @type {{ name: string; pkg: string; external: string[]; entry: string; exports: string[] }[]}
 *
 * `external`: every shared dep the entry internally imports must be
 *   externalised to its sibling vendor bundle so the final stack is a
 *   single React instance. The commonjs plugin rewrites CJS
 *   `require()` of externalised modules into bare ESM imports that
 *   resolve through the web shell's import map.
 */
const vendors = [
  {
    name: 'react.js',
    pkg: 'react',
    entry: 'react.mjs',
    external: [],
    exports: REACT_EXPORTS,
    includeDefault: true,
  },
  {
    name: 'react-jsx-runtime.js',
    pkg: 'react/jsx-runtime',
    entry: 'react-jsx-runtime.mjs',
    // `react/jsx-runtime` doesn't import from `react` — it's a leaf
    // module. Keeping it external-free here lets rollup bundle the
    // actual runtime source. Include the CJS default so the bundled
    // output's namespace is reachable via `import * as` consumers.
    external: [],
    exports: REACT_JSX_RUNTIME_EXPORTS,
    includeDefault: true,
  },
  {
    name: 'react-dom.js',
    pkg: 'react-dom',
    entry: 'react-dom.mjs',
    external: ['react'],
    exports: REACT_DOM_EXPORTS,
    includeDefault: true,
  },
  {
    // `react-dom/client` is upstream just `export { createRoot,
    // hydrateRoot } from 'react-dom'` — a thin wrapper. We model it as
    // a re-export-from-react-dom entry so rollup emits a static
    // `export { createRoot, hydrateRoot }` block AND keeps
    // `react-dom` external. Sourcing from `react-dom` directly avoids
    // the prefix-match problem (rollup's external is exact-match).
    name: 'react-dom-client.js',
    pkg: 'react-dom',
    entry: 'react-dom-client.mjs',
    external: ['react-dom'],
    exports: REACT_DOM_CLIENT_EXPORTS,
    includeDefault: true,
  },
  {
    name: 'react-router-dom.js',
    pkg: 'react-router-dom',
    entry: 'react-router-dom.mjs',
    external: ['react', 'react-dom'],
    exports: REACT_ROUTER_DOM_EXPORTS,
    // react-router-dom 6.x is a pure ESM module without
    // `export default`; adding a default re-export would fail
    // rollup with "No matching export".
    includeDefault: false,
  },
]

// Write the per-package ESM entry files. Each entry enumerates the
// known named re-exports of the target package — rollup's commonjs
// plugin then traces the named bindings through the CJS namespace
// and emits a single static `export { … }` block. We also re-export
// `default` for the CJS packages so consumers like react-dom's
// `import React from 'react'` (which the commonjs plugin converts
// from CJS `require('react')` into a default ESM import) resolve to
// the CJS `module.exports` namespace. Pure ESM packages without
// `export default` (react-router-dom 6.x) do NOT get a default
// re-export — adding one would fail rollup with "No matching export".
//
// We hardcode the per-package choice rather than probe at runtime —
// the probe heuristic is fragile (CJS modules without `.default`
// property report false, ESM modules loaded via require() in Node
// 22+ return a namespace that confuses key-count heuristics).
for (const v of vendors) {
  const lines = []
  lines.push(`// Generated by build-vendor.mjs — DO NOT EDIT.`)
  lines.push(`// Re-exports the public surface of ${v.pkg} as static ESM named exports.`)
  lines.push(`export { ${v.exports.join(', ')} } from ${JSON.stringify(v.pkg)}`)
  if (v.includeDefault) {
    lines.push(`export { default } from ${JSON.stringify(v.pkg)}`)
  }
  await writeFile(join(inputDir, v.entry), lines.join('\n') + '\n', 'utf-8')
}

for (const v of vendors) {
  const entryFile = join(inputDir, v.entry)
  const bundle = await rollup({
    input: entryFile,
    external: v.external,
    plugins: [
      // Replace `process.env.NODE_ENV` with the literal at build time.
      // React's source has `if (process.env.NODE_ENV === 'production')
      // { … }` branches that select dev vs production builds; in the
      // browser `process` is undefined and the check throws. We pick
      // 'development' here because the dev build carries the devtools
      // dispatcher markers the smoke check looks for. Production-only
      // consumers can swap this for 'production' later.
      {
        name: 'replace-process-env-node-env',
        transform(code, id) {
          if (!/\.(js|cjs|mjs|jsx)$/.test(id)) return null
          return {
            code: code.replace(
              /process\.env\.NODE_ENV/g,
              JSON.stringify('development'),
            ),
            map: null,
          }
        },
      },
      nodeResolve({
        preferBuiltins: false,
        extensions: ['.js', '.jsx', '.mjs', '.cjs'],
      }),
      commonjs({
        transformMixedEsModules: true,
        // Force rollup to treat the module's `module.exports` as the
        // namespace (rather than collapsing everything to a single
        // `default` export). This is what makes the explicit
        // `export { X } from '<cjs-pkg>'` entries surface as real
        // named ESM exports.
        defaultIsModuleExports: 'never',
        requireReturnsDefault: 'auto',
        extensions: ['.js', '.cjs'],
      }),
    ],
    onwarn(warning, defaultHandler) {
      // Silence the noisy "preferConst" / "this is undefined" hints
      // from React's development source — they are not actionable
      // here.
      if (warning.code === 'THIS_IS_UNDEFINED' || warning.code === 'PREFER_CONST') return
      if (warning.code === 'CIRCULAR_DEPENDENCY' && /node_modules/.test(warning.message ?? '')) return
      defaultHandler(warning)
    },
  })
  const { output } = await bundle.generate({
    format: 'es',
    inlineDynamicImports: true,
  })
  const chunk = output[0]
  if (!chunk) throw new Error(`build-vendor: no output chunk for ${v.name}`)
  const text = typeof chunk.code === 'string' ? chunk.code : ''
  if (!text) throw new Error(`build-vendor: empty output for ${v.name}`)
  await writeFile(join(outDir, v.name), text, 'utf-8')

  // Smoke 1: every bundle must contain an ESM `export { … }` block
  // (proves rollup emitted real named exports — not just a default
  // re-export from a hidden namespace).
  if (!/^\s*export\s*\{/m.test(text)) {
    throw new Error(
      `build-vendor: ${v.name} contains no "export {" statement (rollup collapsed to default-only)`,
    )
  }

  // Smoke 2: react bundles (the full React core) must carry the
  // dispatcher marker — proves the bundled code is the real React
  // internals (not an accidental stub from a missing export
  // resolution). Subpath bundles like `react/jsx-runtime` are tiny
  // shims and don't carry the marker; skip them.
  const expectInternals = v.pkg === 'react'
  if (expectInternals && !/__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED/.test(text)) {
    throw new Error(`build-vendor: ${v.name} missing react internals marker`)
  }

  // Smoke 3: every enumerated named export must be present in the
  // emitted `export { … }` block. This is the regression check for
  // the rollup bug that produced only `export { index as default }`.
  const exportBlockMatch = text.match(/^export\s*\{[^}]*\}/m)
  if (!exportBlockMatch) {
    throw new Error(`build-vendor: ${v.name} has no export block`)
  }
  const exportBlock = exportBlockMatch[0]
  const missing = v.exports.filter((name) => !new RegExp(`\\b${name}\\b`).test(exportBlock))
  if (missing.length > 0) {
    throw new Error(
      `build-vendor: ${v.name} missing required named exports: ${missing.join(', ')}`,
    )
  }

  console.log(`vendor ${v.name}: ${text.length} bytes (${v.exports.length} named exports)`)
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
// Link is a forwardRef (object), useNavigate is a function — accept
// either type as long as the named export exists.
if (!('Link' in rrdMod) || !('useNavigate' in rrdMod)) {
  throw new Error(
    `build-vendor: react-router-dom.js missing named exports (got ${Object.keys(rrdMod).slice(0, 6).join(',')}…)`,
  )
}
console.log('vendor import smoke ok (Link + useNavigate present)')
