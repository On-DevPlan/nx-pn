/**
 * /api/plugins — list, stop/remove, AND the install-by-name family:
 *   GET  /api/plugins                 → list
 *   GET  /api/plugins/:runId/browser-source → compiled browser-half ESM text
 *   POST /api/plugins                 → multipart zip upload (see upload-route)
 *   POST /api/plugins/install         → { spec } → npm install-by-name
 *   POST /api/plugins/:runId/stop     → fiber.dispose()
 *   POST /api/plugins/:runId/remove   → stop + registry eviction
 *   POST /api/plugins/:runId/uninstall → remove + drop from the npm ledger
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sendJson, sendText } from './http-utils.js'
import type { PluginLifecycle } from '../plugins/lifecycle.js'
import type { BrowserHalfPusher } from '../ws/browser-half-pusher.js'
import { InstallerError, type NpmInstallResult } from '../plugins/installer.js'

export interface PluginRouteDeps {
  lifecycle: PluginLifecycle
  browserHalfPusher: BrowserHalfPusher
  /** npm install-by-name handler (wired by startHost from installer.ts). */
  installNpm: (spec: string) => Promise<NpmInstallResult>
  /** Drop a plugin from the npm ledger by pluginRunId (best-effort). */
  uninstallNpm: (pluginRunId: string) => Promise<void>
}

const MAX_SPEC_BYTES = 4096

export async function handlePluginRoute(deps: PluginRouteDeps, req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
  // /api/plugins OR /api/plugins/:action|:pluginRunId/...
  const segments = urlPath.split('/').filter(Boolean) // ['api', 'plugins', ...]
  if (segments[0] !== 'api' || segments[1] !== 'plugins') {
    sendText(res, 404, 'not found')
    return
  }

  // GET /api/plugins → list
  if (segments.length === 2) {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed')
      return
    }
    const list = deps.lifecycle.list().map((e) => ({
      id: e.id,
      pluginRunId: e.pluginRunId,
      manifest: e.manifest,
    }))
    sendJson(res, 200, { ok: true, data: list })
    return
  }

  // GET /api/plugins/:pluginRunId/browser-source → compiled browser-half ESM
  // text (the web shell feeds it to loadBrowserHalf; spec §5.2.2 path).
  if (segments.length === 4 && segments[3] === 'browser-source') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed')
      return
    }
    const entry = deps.lifecycle.byRunId(segments[2]!)
    if (!entry || !entry.browserSource) {
      sendJson(res, 404, { ok: false, error: { code: 'plugin/no-browser-source', message: 'plugin has no compiled browser half' } })
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/javascript; charset=utf-8')
    res.end(entry.browserSource)
    return
  }

  // POST /api/plugins/install  { spec: string }
  if (segments.length === 3 && segments[2] === 'install') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed')
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req, MAX_SPEC_BYTES)
    } catch (err) {
      sendJson(res, 400, { ok: false, error: { code: 'install/bad-body', message: (err as Error).message } })
      return
    }
    const spec = typeof (body as { spec?: unknown })?.spec === 'string' ? (body as { spec: string }).spec.trim() : ''
    if (!spec) {
      sendJson(res, 400, { ok: false, error: { code: 'install/empty-spec', message: 'body.spec (npm package spec) is required' } })
      return
    }
    try {
      const r = await deps.installNpm(spec)
      // Push the freshly-installed browser half to every connected web shell
      // so the plugin's pages appear without a reload (spec §5.2.1).
      if (r.browserSource) {
        deps.browserHalfPusher.load({ id: r.id, pluginRunId: r.pluginRunId, code: r.browserSource })
      }
      sendJson(res, 201, {
        ok: true,
        data: { id: r.id, pluginRunId: r.pluginRunId, name: r.name, version: r.version },
      })
    } catch (err) {
      if (err instanceof InstallerError) {
        sendJson(res, installStatusFor(err), { ok: false, error: { code: err.code, message: err.message } })
        return
      }
      sendJson(res, 500, { ok: false, error: { code: 'install/failed', message: (err as Error).message } })
    }
    return
  }

  // POST /api/plugins/:pluginRunId/stop|remove|uninstall
  const pluginRunId = segments[2]
  const action = segments[3]
  if (!pluginRunId) {
    sendText(res, 400, 'pluginRunId required')
    return
  }
  if (!action || (action !== 'stop' && action !== 'remove' && action !== 'uninstall')) {
    sendText(res, 404, 'unknown action')
    return
  }
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed')
    return
  }

  const entry = deps.lifecycle.byRunId(pluginRunId)
  if (!entry) {
    sendJson(res, 404, { ok: false, error: { code: 'plugin/not-found', message: 'pluginRunId not found' } })
    return
  }

  if (action === 'stop') {
    await deps.lifecycle.stop(pluginRunId)
    deps.browserHalfPusher.retract(pluginRunId)
    sendJson(res, 200, { ok: true })
    return
  }
  // remove + uninstall both stop & evict; uninstall additionally drops the
  // npm ledger entry so a host restart won't reinstall it. The ledger drop
  // must run BEFORE lifecycle.remove — uninstallNpm resolves the id by
  // pluginRunId, which no longer resolves after eviction.
  deps.browserHalfPusher.retract(pluginRunId)
  if (action === 'uninstall') {
    await deps.uninstallNpm(pluginRunId)
  }
  await deps.lifecycle.remove(pluginRunId)
  sendJson(res, 200, { ok: true })
}

/** Map InstallerError codes to HTTP status. */
function installStatusFor(err: InstallerError): number {
  switch (err.code) {
    case 'install/empty-spec':
    case 'install/bad-spec':
    case 'install/no-module':
    case 'install/no-manifest':
    case 'install/invalid-manifest':
    case 'install/no-export':
      return 400
    case 'plugin/runtime-error':
    case 'install/import-failed':
    case 'install/npm-failed':
    case 'install/timed-out':
    default:
      return 500
  }
}