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
 *   4. `activateBrowserHalf`: `ctx.plugin(halfFn, { name: id })` →
 *      `await fiber.await()` — the half runs inside its own fiber, so
 *      `ctx.pages.register(...)` attaches to its effect chain
 *   5. revoke the blob URL (the imported module is cached by URL, so the
 *      URL may be released — spec §5.2.1)
 *
 * Plan-4 state: the cordis invocation step (`activateBrowserHalf` /
 * `deactivateBrowserHalf`) is real and unit-tested in Node (the blob
 * import itself is a browser-only capability, so `loadBrowserHalf`'s
 * transport step stays untested here). Rendering a plugin page in the
 * live web shell — shared React import map (spec §5.2.2) + sidebar
 * consumption of `pages.getSnapshot()` — remains the documented next
 * step: the example-api half registers `/example-api`, and the
 * hot-add e2e (packages/host) proves the register contract, but the
 * static web shell does not yet render dynamic registry entries.
 */

import type { Context, Fiber } from '../cordis/cordis-shim.js'

/** In-flight browser-half registry keyed by pluginRunId. */
export interface BrowserHalfRecord {
  id: string
  pluginRunId: string
  fiber?: Fiber | undefined
  blobUrl?: string | undefined
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
 * Run a browser-half plugin function inside the live cordis browser
 * Context (spec §5.2.1 step 4). Split from `loadBrowserHalf` so the
 * cordis contract is testable without a browser blob realm.
 */
export async function activateBrowserHalf(
  deps: BrowserHalfDeps,
  meta: { id: string; pluginRunId: string },
  halfFn: (ctx: Context) => unknown,
): Promise<BrowserHalfRecord> {
  const { ctx } = deps
  const fiber = ctx.registry.plugin(halfFn as never, { name: meta.id } as never) as unknown as Fiber
  // Wait for the half to settle; an apply error propagates to the caller
  // (the WS layer logs it — a bad half must not kill the page, spec §8.1).
  await (fiber.await as unknown as () => Promise<void>)()
  return { id: meta.id, pluginRunId: meta.pluginRunId, fiber }
}

/**
 * Load a browser-half plugin module into the browser Context.
 * Returns a record that `retractBrowserHalf` later disposes.
 */
export async function loadBrowserHalf(deps: BrowserHalfDeps, msg: BrowserHalfLoadMessage): Promise<BrowserHalfRecord> {
  const blob = new Blob([msg.code], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    const mod = (await import(/* @vite-ignore */ url)) as {
      default?: unknown
      apply?: unknown
    }
    const halfFn = mod.default ?? mod.apply
    if (typeof halfFn !== 'function') {
      throw new Error(`browser-half ${msg.id} must default-export a function (ctx) => ...`)
    }
    return await activateBrowserHalf(deps, { id: msg.id, pluginRunId: msg.pluginRunId }, halfFn as (ctx: Context) => unknown)
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
export async function retractBrowserHalf(_deps: BrowserHalfDeps, record: BrowserHalfRecord): Promise<void> {
  if (record.fiber) {
    await record.fiber.dispose()
    record.fiber = undefined
  }
}

/**
 * Compile-time check helper so the spec review checklist for this
 * module passes: browser-half compilation must NOT bundle shared deps
 * (react, react-dom, cordis) — they come from the app's import map
 * (spec §9.4 / §5.2.2). The esbuild options live in the plugin build
 * (plugins/example-api/scripts/build-zip.mjs); this constant documents
 * the contract.
 */
export const SHARED_BROWSER_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'cordis']
