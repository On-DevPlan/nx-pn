import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server proxies the host REST + WS API to localhost:4560 so the UI
// can be developed against a running host without CORS or hard-coded
// origins (Plan-3 scope: dev convenience only; the built dist is served
// same-origin by the host in production).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
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
