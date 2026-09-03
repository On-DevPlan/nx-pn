/**
 * Live browser-half sync helpers — the demo feed that turns a loaded
 * plugin's compiled browser half into a real React page in the web shell
 * (spec §5.2.2).
 *
 *   installBrowserHalfFromHost(runtime, { id })
 *     → GET /api/plugins → find by id → GET /:runId/browser-source
 *     → loadBrowserHalf(source, ctx) → ctx.pages.register(...)
 *
 *   loadBrowserHalfSource(...) — the fetch-and-load core, also used by
 *   BrowserRuntime.reconcile on each snapshot so a page refresh /
 *   cold-start repopulates the plugin pages from REST.
 */

import type { Context } from '../cordis/cordis-shim.js'
import { fetchPluginList, type PluginSummary } from '../host-api.js'
import { loadBrowserHalf, type BrowserHalfRecord } from './browser-half-loader.js'

export interface InstallBrowserHalfFromHostOptions {
  /** Manifest id of the plugin to install. */
  id: string
  /** HTTP base for the host REST API ('' = same origin). */
  host?: string
}

/** Fetch a plugin's compiled browser-half ESM source from the host REST API. */
export async function fetchBrowserHalfSource(
  pluginRunId: string,
  hostBase = '',
): Promise<string | undefined> {
  if (typeof fetch !== 'function') return undefined
  const res = await fetch(`${hostBase}/api/plugins/${encodeURIComponent(pluginRunId)}/browser-source`)
  if (!res.ok) return undefined
  return await res.text()
}

/** Load a plugin half's compiled ESM source into a live browser ctx. */
export async function loadBrowserHalfSource(
  ctx: Context,
  meta: { id: string; pluginRunId: string },
  hostBase = '',
): Promise<BrowserHalfRecord | undefined> {
  const code = await fetchBrowserHalfSource(meta.pluginRunId, hostBase)
  if (typeof code !== 'string') return undefined
  return loadBrowserHalf({ ctx }, { id: meta.id, pluginRunId: meta.pluginRunId, code })
}

/**
 * Install a plugin's browser half into the running web app from the host
 * REST API — the "last mile" feed the shell (or a caller) can invoke for
 * the demo. Returns the loaded record, or undefined when the plugin has no
 * browser half / is not loaded on the host.
 */
export async function installBrowserHalfFromHost(
  runtime: { ctx: Context },
  opts: InstallBrowserHalfFromHostOptions,
): Promise<BrowserHalfRecord | undefined> {
  const host = opts.host ?? ''
  let plugins: PluginSummary[]
  try {
    plugins = await fetchPluginList(host)
  } catch {
    return undefined
  }
  const meta = plugins.find((p) => p.id === opts.id)
  if (!meta) return undefined
  if (!meta.manifest.halves.browser?.entry) return undefined
  return loadBrowserHalfSource(runtime.ctx, { id: meta.id, pluginRunId: meta.pluginRunId }, host)
}