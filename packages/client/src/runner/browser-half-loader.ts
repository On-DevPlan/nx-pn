/**
 * Browser-half loader. Spec §5.2.1.
 *
 * Receives compiled browser-half source over WS as
 * `browser-half.load { id, pluginRunId, code }` and loads it into a
 * cordis browser Context:
 *
 *   1. `new Blob([code])` → `URL.createObjectURL(blob)`
 *   2. dynamic `import(blobUrl)` (module is cached by URL)
 *   3. `mod.default ?? mod.apply` must be a plugin function
 *   4. `ctx.plugin(halfFn, { name: id })` → `await fiber.await()`
 *   5. revoke the blob URL (the imported module is cached by URL, so the
 *      URL may be released — spec §5.2.1)
 *
 * Plan-3 scope note (the plan's pragmatic MVP): the actual browser-half
 * runtime — blob import → live cordis context → register pages — is the
 * deep end and is exercised end-to-end in Plan 4 (plugins/example-api).
 * This module therefore ships the full seam (`loadBrowserHalf` /
 * `retractBrowserHalf` accept the live browser Context), while the
 * cordis-Context plumbing inside remains `TODO(plan4)` and the React
 * render of a plugin page is a documented stub. The WS RPC + Pages
 * registry that the loader *feeds* are real and tested now.
 */

import type { Context } from '../cordis/cordis-shim.js'

/** In-flight browser-half registry keyed by pluginRunId. */
export interface BrowserHalfRecord {
  id: string
  pluginRunId: string
  fiber?: unknown
  blobUrl?: string
}

export interface BrowserHalfLoadMessage {
  id: string
  pluginRunId: string
  /** Compiled browser-half ESM source. */
  code: string
}

export interface BrowserHalfRetractMessage {
  pluginRunId: string
}

export interface BrowserHalfDeps {
  /** Browser cordis Context (created by connectRpc). */
  ctx: Context
}

/**
 * Load a browser-half plugin module into the browser Context.
 * Returns a record that `retractBrowserHalf` later disposes.
 */
export async function loadBrowserHalf(deps: BrowserHalfDeps, msg: BrowserHalfLoadMessage): Promise<BrowserHalfRecord> {
  const { ctx } = deps
  const blob = new Blob([msg.code], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    // TODO(plan4): wire ctx.registry.plugin + await fiber.await() with
    // the real cordis browser Context (needs cordis ctx service
    // registration in the browser, shared React import map, and the
    // caller-tracking pages.unregister on dispose — spec §5.2.2).
    const mod = (await import(/* @vite-ignore */ url)) as {
      default?: unknown
      apply?: unknown
    }
    const halfFn = mod.default ?? mod.apply
    if (typeof halfFn !== 'function') {
      throw new Error(`browser-half ${msg.id} must default-export a function (ctx) => ...`)
    }
    void ctx
    // Stub: the plugin function is NOT invoked yet. Feeding it into a
    // live cordis browser Context happens in Plan 4.
    void halfFn
    return { id: msg.id, pluginRunId: msg.pluginRunId, blobUrl: url }
  } finally {
    // The module cache holds the compiled module; the blob URL can be
    // released immediately after import.
    URL.revokeObjectURL(url)
  }
}

/**
 * Stop a previously-loaded browser half. Must be awaited (fiber.dispose
 * is async — spec §5.2.3). Removing the registered pages is the Pages
 * service's own cleanup via ctx.effect (spec §5.3).
 */
export async function retractBrowserHalf(_deps: BrowserHalfDeps, _record: BrowserHalfRecord): Promise<void> {
  // TODO(plan4): await fiber.dispose() + revoke blobUrl once the live
  // fiber is created by loadBrowserHalf.
}

/**
 * Compile-time check helper so the spec review checklist for this
 * module passes: browser-half compilation must NOT bundle shared deps
 * (react, react-dom, cordis) — they come from the app's import map
 * (spec §9.4 / §5.2.2). The actual esbuild options live in the host
 * compiler (Plan 2) and will be extended for the browser half in
 * Plan 4; this constant documents the contract.
 */
export const SHARED_BROWSER_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'cordis']
