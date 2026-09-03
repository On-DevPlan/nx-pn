import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies the host REST + WS API to localhost:4560 so the UI
// can be developed against a running host without CORS or hard-coded
// origins (Plan-3 scope: dev convenience only; the built dist is served
// same-origin by the host in production).
//
// `build.rollupOptions.external` lists the shared React stack — every
// import of `react`, `react-dom`, `react/jsx-runtime`,
// `react-dom/client`, or `react-router-dom` stays a bare specifier in
// the built app and is resolved at runtime by the import map injected
// in `index.html` (spec §5.2.2). The matching vendor bundles are
// produced separately by `scripts/build-vendor.mjs` (rollup +
// node-resolve + commonjs — esbuild can't statically enumerate CJS
// re-exports) and copied into `dist/vendor/` from `public/vendor/`
// during the vite build. Plugin halves loaded later via
// `loadBrowserHalf` (blob import) resolve React to those vendor
// modules — exactly one React instance.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react-router-dom',
      ],
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4560',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:4560',
        ws: true,
      },
    },
  },
})
