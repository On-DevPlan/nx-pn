/**
 * GET /api/plugins — list, POST /api/plugins/:pluginRunId/{stop,remove}.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendText } from './http-utils.js'
import type { PluginLifecycle } from '../plugins/lifecycle.js'
import type { BrowserHalfPusher } from '../ws/browser-half-pusher.js'

export interface PluginRouteDeps {
  lifecycle: PluginLifecycle
  browserHalfPusher: BrowserHalfPusher
}

export async function handlePluginRoute(deps: PluginRouteDeps, req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
  // /api/plugins  OR  /api/plugins/:pluginRunId/stop|remove
  const segments = urlPath.split('/').filter(Boolean) // ['api', 'plugins', ...]
  if (segments[0] !== 'api' || segments[1] !== 'plugins') {
    sendText(res, 404, 'not found')
    return
  }

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

  const pluginRunId = segments[2]
  const action = segments[3]
  if (!pluginRunId) {
    sendText(res, 400, 'pluginRunId required')
    return
  }
  if (!action || (action !== 'stop' && action !== 'remove')) {
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
  if (action === 'remove') {
    deps.browserHalfPusher.retract(pluginRunId)
    await deps.lifecycle.remove(pluginRunId)
    sendJson(res, 200, { ok: true })
    return
  }
}