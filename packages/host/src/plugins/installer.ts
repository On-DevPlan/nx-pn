/**
 * npm install-by-name plugin installer. Spec: npx-plugin refactor.
 *
 * PRIMARY install channel: a plugin is a plain npm package whose
 * `package.json` carries the manifest under `api-audit.manifest` and
 * points `main` (or `exports["."]`) at an ESM host half that default
 * exports `(ctx) => { … }`. npm already delivers compiled JS, so — unlike
 * the zip path — no server-side esbuild is needed: just `import(main)`.
 *
 *   npm install <spec> --prefix <dataDir>/plugins-registry --no-save …
 *     → locate package.json → build core Manifest → validateManifest
 *     → import(hostEntry) → ctx.registry.plugin(fn, { name: id })
 *     → await fiber.await() → lifecycle.register { id, pluginRunId, fiber }
 *     → record the spec in the plugins STORAGE DOMAIN ledger (plugins-domain)
 *       so a host restart can replay it (parity with data-dir/plugins/*.zip)
 *
 * Zip dual-half upload stays as the secondary channel (loader.ts); this
 * module is the new standard path. Attribution works the same way: the
 * plugin's auditClient calls resolve its fiber against the lifecycle
 * registry and get initiator = manifest id (commit 737ab2a).
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MANIFEST_VERSION, validateManifest, type Manifest } from '@flowot/nx-pn-core'
import type { Context, Fiber } from '../cordis/cordis-shim.js'
import type { PluginLifecycle } from './lifecycle.js'
import { PLUGINS_LEDGER_TABLE, pluginsSpec, type PluginsLedgerEntry } from '../domains/plugins-domain.js'
import type { Domain } from '@flowot/nx-pn-storage-domain'
import { makePluginStorage } from '../cordis/plugin-storage-service.js'

/** Sub-directory of dataDir holding the npm registry prefix. */
export const PLUGINS_REGISTRY_DIR = 'plugins-registry'

export interface NpmInstallPluginOptions {
  /** npm spec: "name", "name@ver", "@scope/name", or a file:/folder path. */
  spec: string
  /** Host dataDir (registry lives in dataDir/plugins-registry). */
  dataDir: string
  /** Cordis ctx (from host-context). */
  ctx: Context
  /** Lifecycle registry the loaded fiber gets registered into. */
  lifecycle: PluginLifecycle
  /** Open plugins-ledger domain (npm install-by-name ledger → storage). */
  pluginsDomain: Domain<typeof pluginsSpec>
  /** WS broadcast for plugin lifecycle events (plugin.changed). */
  broadcast?: (op: import('../ws/rpc-bridge.js').RpcOp, payload: unknown) => void
}

export interface NpmInstallResult {
  /** Manifest id (also used as the cordis plugin name → attribution). */
  id: string
  pluginRunId: string
  /** npm package name. */
  name: string
  /** Manifest version (validated). */
  version: string
  /** Absolute path to the imported host-half file. */
  entryPath: string
  manifest: Manifest
  registryDir: string
  /** Compiled browser-half ESM source (if the package declares a browser half). */
  browserSource?: string
  /**
   * pluginRunIds that were evicted because their manifest id collided
   * with this install. Empty for a fresh install; populated by the
   * re-upload dedup in step (5). The new pluginRunId is the sole entry
   * remaining in the lifecycle after installNpmPlugin resolves.
   */
  replaced: string[]
}

/** A single npm-ledger row (mirrors the plugins-domain entry). */
export interface LedgerEntry {
  spec: string
  name: string
  version: string
  installedAt: string
}

export class InstallerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Install a plugin by npm spec and load it into the running host.
 *
 * Mirrors loader.load()'s exact cordis sequence (register BEFORE await so
 * apply-time auditClient calls are already attributable, dispose the fiber
 * on failure) and additionally records the spec in the registry ledger so
 * a later host restart can replay it.
 */
export async function npmInstallPlugin(opts: NpmInstallPluginOptions): Promise<NpmInstallResult> {
  const spec = opts.spec.trim()
  if (!spec) {
    throw new InstallerError('install/empty-spec', 'plugin spec is empty')
  }

  const registryDir = join(opts.dataDir, PLUGINS_REGISTRY_DIR)
  await mkdir(registryDir, { recursive: true })

  // (1) npm install into the registry prefix. Offline-safe for file: specs.
  await runNpmInstall(spec, registryDir)

  // (2) Locate the installed package + read its package.json.
  const { pkgDir, pkg } = await resolveInstalledPkg(registryDir, spec)

  // (3) Build the core Manifest from package.json["api-audit"] (+ main) and
  // run it through the same core validation the zip path uses.
  const name = readRequiredString(pkg, 'name', 'install/no-manifest')
  const manifest = buildManifestFromPkg(pkg)
  const id = manifest.id

  // (4) Import the host half. npm delivers compiled JS — no esbuild.
  if (!manifest.halves.host) {
    throw new InstallerError('install/no-host-half', 'manifest has no host half')
  }
  const entryPath = join(pkgDir, manifest.halves.host.entry)
  let mod: Record<string, unknown>
  try {
    const hash = createHash('sha256').update(await readFile(entryPath)).digest('hex').slice(0, 12)
    // Distinct URL (cache-buster) so a version bump / re-install at the same
    // path always gets a fresh module — mirroring the loader's hashed .mjs.
    mod = (await import(`${pathToFileURL(entryPath).href}?hash=${hash}`)) as Record<string, unknown>
  } catch (err) {
    throw new InstallerError('install/import-failed', `host half import failed: ${(err as Error).message}`)
  }
  const halfFn = (mod.default ?? (mod as { apply?: unknown }).apply) as ((ctx: Context) => unknown | Promise<unknown>) | undefined
  if (typeof halfFn !== 'function') {
    throw new InstallerError('install/no-export', 'host half must default-export a function (ctx) => ...')
  }

  // (4b) Read the compiled browser-half ESM source (if declared) so the web
  // shell can render its pages (GET /api/plugins/:runId/browser-source).
  // npm delivers compiled JS already — the file is read verbatim.
  let browserSource: string | undefined
  const browserEntryName = manifest.halves.browser?.entry
  if (browserEntryName) {
    try {
      browserSource = await readFile(join(pkgDir, browserEntryName), 'utf-8')
    } catch (err) {
      throw new InstallerError('install/missing-browser-entry', `browser half "${browserEntryName}" not found in ${pkgDir}: ${(err as Error).message}`)
    }
  }

  // (5) Upsert: evict any running instance of the same manifest id so
  // re-install / upgrade leaves exactly one live fiber. We collect the
  // evicted pluginRunIds so the caller can surface them in the REST
  // response (the loader does the same — same surface, same semantics).
  // lifecycle.remove disposes the fiber AND broadcasts
  // `browser-half.retract { id, pluginRunId }` to every connected WS, so
  // connected browsers drop the old browser half + pages before the new
  // host half loads.
  const replaced: string[] = []
  for (const existing of opts.lifecycle.listById(id)) {
    replaced.push(existing.pluginRunId)
    await opts.lifecycle.remove(existing.pluginRunId)
  }

  // (6) Load into cordis. Mirrors loader.ts exactly: register the entry
  // first (kicks off the `plugin-<id>` ns domain open), await the open
  // (fail-loud), then activate a WRAPPED half that injects
  // `ctx.pluginStorage` over the open domain, and back-fill the fiber onto
  // the entry — the plugin is attributable from its first apply-time
  // auditClient call (callerInitiator matches by fiber uid).
  const pluginRunId = opts.lifecycle.nextRunId()
  const entry: import('./lifecycle.js').LifecycleEntry = {
    id,
    pluginRunId,
    manifest,
    ...(browserSource !== undefined ? { browserSource } : {}),
  }
  opts.lifecycle.register(entry)
  if (entry.storagePromise) {
    try {
      await entry.storagePromise
    } catch (err) {
      try {
        await opts.lifecycle.remove(pluginRunId)
      } catch {
        // swallow — original error takes precedence
      }
      throw new InstallerError('plugin/storage-open-failed', (err as Error).message)
    }
  }
  const nsDomain = entry.storageDomain
  let wrapped: (ctx: Context, config?: { name?: string }) => unknown
  if (nsDomain) {
    wrapped = (ctx: Context, config?: { name?: string }): unknown => {
      const scoped = Object.create(ctx as object)
      // Non-enumerable own property: cordis enumerates the plugin's own
      // keys during fiber registration and rejects any key that appears
      // across multiple fibers (see loader.ts for the full rationale).
      Object.defineProperty(scoped, 'pluginStorage', {
        value: makePluginStorage(nsDomain, id),
        enumerable: false,
        writable: false,
        configurable: false,
      })
      return (halfFn as (c: Context, cfg?: { name?: string }) => unknown)(scoped, config)
    }
    // Carry the half's own metadata (notably `inject`) onto the wrapper —
    // cordis reads them off the plugin value to gate activation on
    // service readiness.
    Object.assign(wrapped, halfFn)
  } else {
    wrapped = halfFn as (ctx: Context, config?: { name?: string }) => unknown
  }
  const fiber = opts.ctx.registry.plugin(wrapped as never, { name: id } as never) as Fiber
  ;(entry as { fiber: Fiber }).fiber = fiber
  try {
    await (fiber.await as unknown as () => Promise<void>)()
  } catch (err) {
    try {
      await opts.lifecycle.remove(pluginRunId)
    } catch {
      // swallow — original error takes precedence
    }
    throw new InstallerError('plugin/runtime-error', (err as Error).message)
  }

  // (7) Record the successful install for restart replay — the ledger now
  // lives in the plugins storage domain (plugins-domain.ts). The installer
  // no longer reads/writes data-dir/plugins-registry/installed.json: a
  // pre-existing file from a file-ledger host is NOT migrated (v1 design
  // decision) and is left untouched on disk.
  const ledger = await readLedger(opts)
  ledger[id] = { spec, name, version: manifest.version, installedAt: new Date().toISOString() }
  await writeLedger(opts, ledger)

  opts.broadcast?.('plugin.changed', {
    type: 'install',
    id,
    pluginRunId,
    replaced,
  })

  return {
    id,
    pluginRunId,
    name,
    version: manifest.version,
    entryPath,
    manifest,
    registryDir,
    replaced,
    ...(browserSource !== undefined ? { browserSource } : {}),
  }
}

/**
 * Restart replay (best-effort): reinstall every ledgered npm plugin into a
 * fresh host. Called by startHost after the zip replay. Skips + logs any
 * spec that fails to install (e.g. offline with a registry spec).
 */
export async function restartNpmPlugins(opts: {
  dataDir: string
  ctx: Context
  lifecycle: PluginLifecycle
  pluginsDomain: Domain<typeof pluginsSpec>
}): Promise<NpmInstallResult[]> {
  const ledger = await readLedger(opts)
  const results: NpmInstallResult[] = []
  for (const entry of Object.values(ledger)) {
    try {
      results.push(await npmInstallPlugin({ spec: entry.spec, dataDir: opts.dataDir, ctx: opts.ctx, lifecycle: opts.lifecycle, pluginsDomain: opts.pluginsDomain }))
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin-installer] restart failed for ${entry.name}:`, (err as Error).message)
    }
  }
  return results
}

/** Drop a plugin from the install ledger (idempotent; zip plugins absent). */
export async function uninstallNpmPlugin(opts: { id: string; dataDir: string; pluginsDomain: Domain<typeof pluginsSpec> }): Promise<void> {
  const ledger = await readLedger(opts)
  if (!(opts.id in ledger)) return
  delete ledger[opts.id]
  await writeLedger(opts, ledger)
}

// ------------------------------------------------------------------ details

/** Run `npm install <spec> --prefix <registryDir>` and throw on failure. */
function runNpmInstall(spec: string, registryDir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // `--prefix` (not cwd) is required: plain `npm install` in a package-less
    // prefix is unreliable on this setup. Prefix is quoted + slash-normalised.
    const isWin = process.platform === 'win32'
    const prefix = registryDir.replace(/\\/g, '/')
    const args = isWin
      ? ['/d', '/s', '/c', 'npm', 'install', spec, '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', '--no-package-lock', '--no-update-notifier']
      : ['install', spec, '--prefix', registryDir, '--no-save', '--no-audit', '--no-fund', '--no-package-lock', '--no-update-notifier']
    execFile(
      isWin ? 'cmd.exe' : 'npm',
      args,
      { cwd: registryDir, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr + '').trim() || (stdout + '').trim() || err.message
          let code = 'install/npm-failed'
          if (err.killed) code = 'install/timed-out'
          reject(new InstallerError(code, `npm install "${spec}" failed: ${detail.slice(0, 800)}`))
          return
        }
        resolvePromise()
      },
    )
  })
}

/** Locate the installed package dir + parsed package.json. */
async function resolveInstalledPkg(
  registryDir: string,
  spec: string,
): Promise<{ pkgDir: string; pkg: Record<string, unknown> }> {
  // file: specs → npm links/copies the folder; read the spec target directly.
  if (spec.startsWith('file:')) {
    const target = resolve(spec.slice('file:'.length))
    return { pkgDir: target, pkg: await readPkgSafe(target) }
  }

  const bare = bareName(spec)
  if (!bare) {
    throw new InstallerError('install/bad-spec', `cannot determine package name from spec "${spec}"`)
  }
  const nmDir = join(registryDir, 'node_modules')
  const pkgDir = bare.includes('/') ? join(nmDir, ...bare.split('/')) : join(nmDir, bare)
  return { pkgDir, pkg: await readPkgSafe(pkgDir) }
}

async function readPkgSafe(pkgDir: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(join(pkgDir, 'package.json'), 'utf-8')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('package.json is not an object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    throw new InstallerError('install/no-module', `cannot read package.json at ${pkgDir} after npm install: ${(err as Error).message}`)
  }
}

function readRequiredString(pkg: Record<string, unknown>, key: string, code: string): string {
  const value = pkg[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new InstallerError(code, `package.json missing required field "${key}"`)
  }
  return value
}

/** Build + validate a core Manifest from package.json["api-audit"]. */
function buildManifestFromPkg(pkg: Record<string, unknown>): Manifest {
  const hostEntry = resolveHostEntry(pkg)
  const apiAudit = pkg['api-audit'] as { manifest?: Record<string, unknown>; browser?: string } | undefined
  const rawManifest = apiAudit?.manifest
  if (!rawManifest || typeof rawManifest !== 'object') {
    throw new InstallerError(
      'install/no-manifest',
      'package has no api-audit.manifest — see docs for the plugin package format ({ api-audit: { manifest: { id, version, title }, browser? } })',
    )
  }
  const browser = typeof apiAudit?.browser === 'string' ? apiAudit.browser : undefined
  const halves: { host: { entry: string }; browser?: { entry: string } } = { host: { entry: hostEntry } }
  if (browser) halves.browser = { entry: browser }
  try {
    return validateManifest({ schemaVersion: MANIFEST_VERSION, ...rawManifest, halves })
  } catch (err) {
    throw new InstallerError('install/invalid-manifest', (err as Error).message)
  }
}

/**
 * Resolve the host-half entry: `main`, else `exports["."]["default"]`,
 * else `index.js` (mirrors the package-format spec).
 */
function resolveHostEntry(pkg: Record<string, unknown>): string {
  if (typeof pkg.main === 'string' && pkg.main.length > 0) return pkg.main
  const exportsField = pkg.exports
  if (exportsField && typeof exportsField === 'object') {
    const dot = (exportsField as Record<string, unknown>)['.']
    if (typeof dot === 'string') return dot
    if (dot && typeof dot === 'object') {
      const def = (dot as Record<string, unknown>)['default']
      if (typeof def === 'string' && def.length > 0) return def
    }
  }
  return 'index.js'
}

/**
 * Strip a trailing @version from a spec to get the bare package name.
 * Returns null for specs we can't identify (file: handled separately).
 */
function bareName(spec: string): string | null {
  let s = spec.trim()
  if (s.startsWith('npm:')) s = s.slice('npm:'.length)
  if (s.startsWith('file:') || s.startsWith('git') || s.startsWith('http:') || s.startsWith('https:')) return null
  const at = s.indexOf('@', s.includes('/') ? s.indexOf('/') : 0)
  if (at > 0) s = s.slice(0, at)
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9-._~]+$/i.test(s)) return null
  return s
}

// ------------------------------------------------------------- ledger helpers

/**
 * Read the ledger as a plain `Record<id, LedgerEntry>` from the plugins
 * storage domain's `installed` table. The old file-backed ledger
 * (installed.json) is no longer consulted.
 */
async function readLedger(opts: { pluginsDomain: Domain<typeof pluginsSpec> }): Promise<Record<string, PluginsLedgerEntry>> {
  const table = opts.pluginsDomain.table(PLUGINS_LEDGER_TABLE)
  const out: Record<string, PluginsLedgerEntry> = {}
  for (const [key, value] of table.entries()) {
    out[key] = value as PluginsLedgerEntry
  }
  return out
}

/** Write the whole ledger back into the plugins storage domain. */
async function writeLedger(opts: { pluginsDomain: Domain<typeof pluginsSpec> }, ledger: Record<string, PluginsLedgerEntry>): Promise<void> {
  const table = opts.pluginsDomain.table(PLUGINS_LEDGER_TABLE)
  // Upsert the provided rows, removing any row absent from the new map
  // (a full replacement keeps the domain's state equal to the caller's).
  const next = new Map<string, PluginsLedgerEntry>()
  for (const [id, entry] of Object.entries(ledger)) next.set(id, entry)
  const seen = new Set<string>()
  for (const [key] of table.entries()) {
    if (next.has(key)) {
      seen.add(key)
      const entry = next.get(key)!
      if (JSON.stringify(table.get(key)) !== JSON.stringify(entry)) {
        await table.put(key, entry)
      }
    } else {
      await table.delete(key)
    }
  }
  for (const [id, entry] of next) {
    if (seen.has(id)) continue
    await table.put(id, entry)
  }
}