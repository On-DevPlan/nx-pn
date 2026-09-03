/**
 * Frontend static service. Spec §2.3.1 / §4.1 (frontend-static.ts).
 *
 * Resolves `@api-audit/web/package.json` via createRequire + require.resolve
 * to anchor the dist directory. Per-request readFile (no caching).
 * Tolerates missing dist → returns null and the route serves 503.
 */

import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'

export interface FrontendStaticServiceOptions {
  /** Override the module URL used by createRequire. Defaults to import.meta.url. */
  moduleUrl?: string
  /** Override the package name to resolve. Defaults to '@api-audit/web'. */
  packageName?: string
  /** Override the dist sub-path. Defaults to 'dist'. */
  distSubpath?: string
}

export interface FrontendStaticService {
  /** Resolve once at startup. Returns the dist root, or null if missing. */
  resolveDistRoot(): Promise<string | null>
  /** Per-request: resolve an HTTP path to an absolute file + content-type. */
  resolveRequest(urlPath: string): Promise<{ absolutePath: string; contentType: string } | null>
  /** Per-request: read file bytes (UTF-8). */
  readFile(absolutePath: string): Promise<Buffer>
}

export function createFrontendStaticService(
  opts: FrontendStaticServiceOptions = {},
): FrontendStaticService {
  const moduleUrl = opts.moduleUrl ?? import.meta.url
  const packageName = opts.packageName ?? '@api-audit/web'
  const distSubpath = opts.distSubpath ?? 'dist'

  let cachedRoot: string | null | undefined

  return {
    async resolveDistRoot(): Promise<string | null> {
      if (cachedRoot !== undefined) return cachedRoot
      try {
        const req = createRequire(moduleUrl)
        const pkgJsonPath = req.resolve(`${packageName}/package.json`)
        const distRoot = normalize(join(dirname(pkgJsonPath), distSubpath))
        // Confirm it actually exists.
        const s = await stat(distRoot)
        if (!s.isDirectory()) {
          cachedRoot = null
          return null
        }
        cachedRoot = distRoot
        return distRoot
      } catch {
        cachedRoot = null
        return null
      }
    },

    async resolveRequest(urlPath: string): Promise<{ absolutePath: string; contentType: string } | null> {
      const root = await this.resolveDistRoot()
      if (root === null) return null

      // Strip query/hash
      const cleanPath = urlPath.split('?')[0]!.split('#')[0]!
      let rel = cleanPath === '/' ? '/index.html' : cleanPath
      if (rel.includes('..')) return null // path traversal guard

      const absolutePath = join(root, rel)
      try {
        const s = await stat(absolutePath)
        if (!s.isFile()) return null
        const contentType = guessContentType(absolutePath)
        return { absolutePath, contentType }
      } catch {
        // SPA fallback: any non-asset path → index.html (best-effort)
        if (!cleanPath.startsWith('/assets/')) {
          const fallback = join(root, 'index.html')
          try {
            const s2 = await stat(fallback)
            if (!s2.isFile()) return null
            return { absolutePath: fallback, contentType: 'text/html; charset=utf-8' }
          } catch {
            return null
          }
        }
        return null
      }
    },

    async readFile(absolutePath: string): Promise<Buffer> {
      return await readFile(absolutePath)
    },
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function guessContentType(path: string): string {
  const lower = path.toLowerCase()
  const ext = lower.slice(lower.lastIndexOf('.'))
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}