/**
 * HTTP server. Spec §4.1 / §4.2.
 *
 * Routes:
 *   GET  /api/audit            → handleAuditRoute
 *   POST /api/replay           → handleReplayRoute
 *   POST /api/plugins          → handleUploadPlugin
 *   POST /api/plugins/install  → handlePluginRoute (npm install-by-name)
 *   GET  /api/plugins          → handlePluginRoute (list)
 *   POST /api/plugins/:id/{stop|remove|uninstall} → handlePluginRoute
 *   GET  /                     → frontend-static (or 503 if dist missing)
 *   GET  /assets/*             → frontend-static
 *   WS   /ws                   → ws-server upgrade (handled by startHost)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { sendJson } from './http-utils.js'
import { handleAuditRoute, type AuditRouteDeps } from './audit-route.js'
import { handlePluginRoute, type PluginRouteDeps } from './plugin-route.js'
import { handleUploadPlugin } from './upload-route.js'
import { handleReplayRoute, type ReplayRouteDeps } from './replay-route.js'
import {
  createFrontendStaticService,
  type FrontendStaticService,
} from './frontend-static.js'
import type { PluginLoader } from '../plugins/loader.js'

export interface HttpServerDeps extends AuditRouteDeps, PluginRouteDeps, ReplayRouteDeps {
  /** Required by handleUploadPlugin. */
  loader: PluginLoader
}

export interface HttpServerOptions {
  port?: number
  host?: string
}

export interface StartedHttp {
  /** Underlying http.Server (so the caller can pass to handleUpgrade). */
  server: import('node:http').Server
  /** Resolved port (useful when caller passed 0). */
  port: number
  frontend: FrontendStaticService
  /** Stop accepting connections and close the underlying socket. */
  close(): Promise<void>
}

export async function startHttpServer(deps: HttpServerDeps, opts: HttpServerOptions = {}): Promise<StartedHttp> {
  const frontend = createFrontendStaticService()
  const server = createServer((req, res) => {
    handle(req, res, deps, frontend).catch((err) => {
      // Final guard — every handler should catch, but stay defensive.
      try {
        sendJson(res, 500, { ok: false, error: { code: 'internal', message: (err as Error).message } })
      } catch {
        try {
          res.statusCode = 500
          res.end()
        } catch {
          // ignore
        }
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListen)
      reject(err)
    }
    const onListen = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListen)
    server.listen(opts.port ?? 4560, opts.host ?? '127.0.0.1')
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 4560)

  return {
    server,
    port,
    frontend,
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  frontend: FrontendStaticService,
): Promise<void> {
  const url = req.url ?? '/'

  if (url.startsWith('/api/')) {
    if (url === '/api/audit' || url.startsWith('/api/audit?')) {
      handleAuditRoute(deps, req, res, url)
      return
    }
    if (url === '/api/replay' || url.startsWith('/api/replay?')) {
      await handleReplayRoute(deps, req, res)
      return
    }
    if (url === '/api/plugins' || url.startsWith('/api/plugins?')) {
      if (req.method === 'GET') {
        await handlePluginRoute(deps, req, res, '/api/plugins')
      } else if (req.method === 'POST') {
        await handleUploadPlugin(deps, req, res)
      } else {
        sendJson(res, 405, { ok: false, error: { code: 'method/not-allowed', message: 'GET or POST only' } })
      }
      return
    }
    if (url.startsWith('/api/plugins/')) {
      await handlePluginRoute(deps, req, res, url.split('?')[0]!)
      return
    }
    sendJson(res, 404, { ok: false, error: { code: 'route/not-found', message: `unknown api path ${url}` } })
    return
  }

  // Frontend static
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: { code: 'method/not-allowed', message: 'GET only' } })
    return
  }
  const resolved = await frontend.resolveRequest(url)
  if (!resolved) {
    sendJson(res, 503, { ok: false, error: { code: 'frontend/not-built', message: 'apps/web dist missing — run `pnpm --filter web build`' } })
    return
  }
  try {
    const buf = await frontend.readFile(resolved.absolutePath)
    res.statusCode = 200
    res.setHeader('content-type', resolved.contentType)
    res.setHeader('cache-control', 'no-cache')
    res.end(buf)
  } catch {
    sendJson(res, 404, { ok: false, error: { code: 'frontend/missing-file', message: 'file not found' } })
  }
}