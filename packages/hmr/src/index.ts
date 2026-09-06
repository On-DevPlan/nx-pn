/**
 * @flowot/nx-pn-hmr — file watcher + rebuild + hot-upload.
 *
 * Mirrors koishi's @koishijs/plugin-hmr shape: a cordis Service with
 * start/stop methods. Models a plugin's HMR lifecycle as a watched tree of
 * source files; on each change, derives the owning pluginId, runs the
 * workspace's build script to produce dist/<id>.zip, then POSTs the zip
 * to the running host (the host's runId dedup hot-replaces).
 *
 * Standalone: no chokidar dep (uses node:fs.watch like scripts/dev.mjs
 * already does successfully on Windows). The class is exported as the
 * default service factory so any cordis-based host can register it.
 */

import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, relative, sep } from 'node:path'

/** Same SKIP regex as the in-line HMR in scripts/dev.mjs. */
const SKIP = /^(dist[/\\]|node_modules[/\\]|\.git[/\\]|\.data[/\\]|host\.js$|browser\.js$|manifest\.json$)/
const SOURCE = /\.(ts|tsx|json)$/

/** i18n messages (en-US default; zh-CN mirror). */
type MsgFn = (...args: any[]) => string
const messages: Record<string, Record<string, MsgFn>> = {
  'en-US': {
    hmr_started: (root: string) => `[hmr] watching ${root} (Ctrl+C to exit)`,
    hmr_change: (rel: string) => `\n[hmr] change: ${rel}`,
    hmr_ok: (id: string, runId: string, replaced: string, ms: number) => `[hmr] ok ${id} -> run=${runId}${replaced} (${ms}ms)`,
    hmr_fail: (id: string, msg: string) => `[hmr] failed ${id}: ${msg}\n      fix and save again to retry`,
    hmr_rebuild: (id: string) => `[hmr] rebuilding ${id}...`,
  },
  'zh-CN': {
    hmr_started: (root: string) => `[hmr] 监听 ${root} (Ctrl+C 退出)`,
    hmr_change: (rel: string) => `\n[hmr] 变更: ${rel}`,
    hmr_ok: (id: string, runId: string, replaced: string, ms: number) => `[hmr] 完成 ${id} -> run=${runId}${replaced} (${ms}ms)`,
    hmr_fail: (id: string, msg: string) => `[hmr] 失败 ${id}: ${msg}\n      修复后保存文件自动重试`,
    hmr_rebuild: (id: string) => `[hmr] 重建 ${id}...`,
  },
}

/** Resolve a pluginId from a path relative to root (plugins/<id>/...). */
function pluginIdFromPath(root: string, filename: string): string | null {
  const rel = relative(root, join(root, filename)).split(sep).join('/')
  if (!rel || rel.startsWith('..') || rel.startsWith('.')) return null
  return rel.split('/')[0] || null
}

/** Build result shape. */
export interface BuildResult { code: number; stdout: string; stderr: string }

/** Hmr configuration. */
export interface HmrConfig {
  /** Directory to watch (e.g. <root>/plugins). */
  root: string
  /** Upload endpoint (default: http://localhost:4560/api/plugins). */
  uploadUrl: string
  /** Debounce interval in ms (default: 500). */
  debounceMs?: number
  /** Locale for messages (default: 'en-US'). */
  locale?: string
  /** Build function: (pluginId, pluginDir) => {code, stdout, stderr}. */
  build: (pluginId: string, pluginDir: string) => Promise<BuildResult>
}

/** Default config. */
export function defaultConfig(opts: Partial<HmrConfig> = {}): HmrConfig {
  return {
    root: opts.root ?? process.cwd(),
    uploadUrl: opts.uploadUrl ?? 'http://localhost:4560/api/plugins',
    debounceMs: opts.debounceMs ?? 500,
    locale: opts.locale ?? 'en-US',
    build: opts.build ?? (async () => ({ code: 0, stdout: '', stderr: '' })),
  }
}

/** POST a zip to the host /api/plugins endpoint. */
async function uploadZip(uploadUrl: string, pluginId: string, zipBytes: Uint8Array) {
  const form = new FormData()
  form.append('zip', new Blob([zipBytes as BlobPart]), `${pluginId}.zip`)
  const res = await fetch(uploadUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { pluginRunId?: string; replaced?: string[] }; error?: { code?: string; message?: string } } | null
  if (!res.ok || !json?.ok) {
    const e = json?.error
    throw new Error(`upload failed (HTTP ${res.status}${e ? `, ${e.code}: ${e.message}` : ''})`)
  }
  return json.data
}

/**
 * Hmr — a standalone class that watches a plugin source tree and
 * hot-uploads the affected plugin's rebuilt zip to the running host.
 */
export class Hmr {
  readonly config: HmrConfig
  private _watcher: ReturnType<typeof watch> | null = null
  private _pending = new Set<string>()
  private _draining = new Set<string>()
  private _i18n: Record<string, MsgFn>
  private _timer: ReturnType<typeof setTimeout> | null = null

  constructor(config: Partial<HmrConfig>) {
    this.config = defaultConfig(config)
    this._i18n = messages[this.config.locale ?? 'en-US'] ?? messages['en-US']!
  }

  start(): void {
    if (this._watcher) return
    this._log('hmr_started', this.config.root)
    this._watcher = watch(this.config.root, { recursive: true }, (_ev, filename) => {
      if (!filename) return
      const rel = filename.split(sep).join('/')
      if (SKIP.test(rel) || !SOURCE.test(rel)) return
      const pluginId = pluginIdFromPath(this.config.root, filename)
      if (!pluginId) return
      this._log('hmr_change', rel)
      this._enqueue(pluginId)
    })
  }

  stop(): void {
    if (this._watcher) { this._watcher.close(); this._watcher = null }
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    this._pending.clear()
    this._draining.clear()
  }

  private _enqueue(pluginId: string): void {
    this._pending.add(pluginId)
    if (this._draining.has(pluginId)) return
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._timer = null
      for (const id of [...this._pending]) void this._drain(id)
    }, this.config.debounceMs ?? 500)
  }

  private async _drain(pluginId: string): Promise<void> {
    this._draining.add(pluginId)
    while (this._pending.has(pluginId)) {
      this._pending.delete(pluginId)
      const t0 = Date.now()
      this._log('hmr_rebuild', pluginId)
      try {
        const pluginDir = join(this.config.root, pluginId)
        const { code, stdout, stderr } = await this.config.build(pluginId, pluginDir)
        if (code !== 0) throw new Error((stderr || stdout).trim() || `build exited ${code}`)
        const zipPath = join(pluginDir, 'dist', `${pluginId}.zip`)
        const zip = await readFile(zipPath)
        const data = await uploadZip(this.config.uploadUrl, pluginId, zip)
        const replaced = Array.isArray(data?.replaced) && data.replaced.length > 0
          ? ` (replaced ${data.replaced.join(', ')})`
          : ''
        this._log('hmr_ok', pluginId, data?.pluginRunId ?? '?', replaced, Date.now() - t0)
      } catch (err) {
        this._log('hmr_fail', pluginId, err instanceof Error ? err.message : String(err))
      }
    }
    this._draining.delete(pluginId)
  }

  private _log(key: string, ...args: any[]): void {
    const fn = this._i18n[key] ?? messages['en-US']![key]!
    if (fn) console.log(fn(...args))
  }
}

/**
 * HmrService — cordis-shaped adapter (matches koishi plugin-hmr convention).
 * The host registers it via ctx.plugin(HmrService, { root, ... }).
 */
export class HmrService {
  static readonly service = 'hmr'
  declare readonly start: () => void
  declare readonly stop: () => void

  constructor(ctx: unknown, config: Partial<HmrConfig>) {
    this.ctx = ctx as { on?: (ev: string, fn: () => void) => void }
    this.config = config
    this._hmr = null
  }

  apply(): void {
    this._hmr = new Hmr(this.config)
    this._hmr.start()
    this.ctx.on?.('dispose', () => this._hmr?.stop())
  }

  private ctx: { on?: (ev: string, fn: () => void) => void }
  private config: Partial<HmrConfig>
  private _hmr: Hmr | null
}

export default Hmr
