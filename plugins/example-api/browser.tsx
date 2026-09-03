/**
 * example-api — browser half of the demo dual-half zip plugin (spec §5.2,
 * §5.3). Compiled to an ESM string by `scripts/build-zip.mjs` (platform
 * browser, jsx automatic, shared deps external) and shipped inside the
 * zip as `browser.js`.
 *
 * When a browser runtime loads this half (WS `browser-half.load` → blob
 * import → cordis plugin), it registers its navigation entry through the
 * Pages service — the exact contract `packages/client` defines. The
 * registration attaches to this half's fiber effect chain, so disposing
 * the plugin removes the entry automatically.
 *
 * Deliberately dependency-free (no React import): the compiled module is
 * a zero-import ESM file, so the "does the half honour the
 * pages.register contract" question can be proven without a live
 * browser realm (see the hot-add e2e test in packages/host).
 */

/** Structural view of the browser plugin ctx this half relies on. */
interface BrowserCtx {
  logger: {
    info(message: string): void
  }
  /** Pages service (spec §5.3, prototype methods). */
  pages: {
    register(entry: {
      pluginId: string
      path: string
      title: string
      order?: number
      icon?: string
      Component?: unknown
    }): unknown
  }
}

export default function browserHalf(ctx: BrowserCtx): void {
  ctx.logger.info('[example-api] browser half active — registering /example-api')
  ctx.pages.register({
    pluginId: 'example-api',
    path: '/example-api',
    title: '示例 API',
    order: 200,
  })
}
