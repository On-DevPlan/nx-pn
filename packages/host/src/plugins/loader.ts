/**
 * Plugin loader orchestrator. Spec §4.4.1.
 *
 *   POST /api/plugins
 *     → unzip → data-dir/plugins/<id>-<upload_id>.zip
 *     → validateManifest(parsed)
 *     → esbuild compile host half → data-dir/cache/compiled/<id>-<hash>.mjs
 *     → pathToFileURL(.mjs).href → import()
 *     → lifecycle.register { id, pluginRunId } (opens plugin-<id> ns domain)
 *     → await ns domain open (fail-loud: no open domain, no plugin)
 *     → ctx.plugin(wrappedFn, { name: id }) — wrappedFn injects
 *       ctx.pluginStorage over the open domain
 *     → await fiber.await()
 *     → on failure: catch → lifecycle.remove (fiber dispose + ns close) → throw
 */

import { mkdir, writeFile, rm, readFile, readdir, realpath, access } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import type { Context, Fiber } from '../cordis/cordis-shim.js'
import {
  MANIFEST_VERSION,
  validateManifest,
  type Manifest,
  MAX_ZIP_BYTES,
} from '@flowot/nx-pn-core'

import { compileHostHalf, importCompiledModule } from './host-compiler.js'
import { PluginLifecycle } from './lifecycle.js'
import { makePluginStorage } from '../cordis/plugin-storage-service.js'

export interface LoaderDeps {
  dataDir: string
  ctx: Context
  lifecycle: PluginLifecycle
}

export interface LoadOptions {
  /** Raw zip bytes. */
  zipBytes: Uint8Array
  /** Override id (defaults to manifest.id). */
  idHint?: string
}

export interface LoadResult {
  id: string
  pluginRunId: string
  manifest: Manifest
  /** Path to the .mjs that was loaded. */
  compiledPath: string
  /** Optional path to the persisted .zip. */
  zipPath: string
  /** Compiled browser-half ESM source (if the manifest declares one). */
  browserSource?: string
  /**
   * pluginRunIds evicted by the dedup before this load landed. Empty for
   * a fresh upload; populated when an existing run of the same manifest
   * id was present (re-upload replaces). Mirrors the installer's
   * `replaced` array so the REST handler can surface the same shape
   * regardless of channel.
   */
  replaced: string[]
  /**
   * Optional peer-dependency warning string. Present when the plugin's
   * package.json declared a @flowot/nx-pn-host peer with a version range
   * that does not include the current host version.
   */
  peerWarning?: string
}

export class PluginLoader {
  constructor(private readonly deps: LoaderDeps) {}

  /** Persist a zip under data-dir/plugins/ and load it. */
  async load(opts: LoadOptions): Promise<LoadResult> {
    if (opts.zipBytes.byteLength > MAX_ZIP_BYTES) {
      throw new LoaderError('zip/too-large', `zip exceeds MAX_ZIP_BYTES (${MAX_ZIP_BYTES})`)
    }

    // (1) Persist zip
    const uploadId = randomBytes(6).toString('hex')
    const zipPath = join(this.deps.dataDir, 'plugins', `${uploadId}.zip`)
    await mkdir(dirname(zipPath), { recursive: true })
    await writeFile(zipPath, opts.zipBytes)

    // (3) Read manifest
    const { manifest: rawManifest } = await extractManifestAndEntryFromZipFile(zipPath)
    // (3b) Validate manifest BEFORE extracting entries — schema violations
    // must surface as `Invalid manifest`, not as missing-host-entry errors.
    const manifest = validateManifest(rawManifest)
    const id = opts.idHint ?? manifest.id

    if (manifest.halves.host === undefined) {
      throw new LoaderError('manifest/no-host-half', 'manifest.halves.host.entry is required (no host half declared)')
    }
    const hostEntryName = manifest.halves.host.entry
    if (!hostEntryName) {
      throw new LoaderError('manifest/no-host-half', 'manifest.halves.host.entry is required')
    }

    // (3c) Extract the compiled browser-half ESM source (if declared) so the
    // web shell can fetch it (GET /api/plugins/:runId/browser-source) and the
    // upload route can push it straight away. Missing entry → not a hard error
    // (a browser half is optional); malformed entry → surface the zip error.
    let browserSource: string | undefined
    const browserEntryName = manifest.halves.browser?.entry
    if (browserEntryName) {
      try {
        const raw = await readEntryFromZipFile(zipPath, browserEntryName)
        browserSource = Buffer.from(raw).toString('utf-8')
      } catch (err) {
        if (err instanceof LoaderError && err.code === 'zip/missing-entry') {
          throw new LoaderError('manifest/missing-browser-entry', `manifest.halves.browser.entry "${browserEntryName}" missing from zip`)
        }
        throw err
      }
    }

    // Materialise the host entry source from the zip so esbuild can read it.
    const hostSource = await readEntryFromZipFile(zipPath, hostEntryName)
    const osTmp = await realpath(tmpdir())
    const tmpSource = join(osTmp, `api-audit-src-${createHash('sha256').update(hostSource).digest('hex').slice(0, 16)}.mjs`)
    await writeFile(tmpSource, hostSource)

    // (4) Compile host half
    const compiledDir = join(this.deps.dataDir, 'cache', 'compiled')
    const compileResult = await compileHostHalf({
      entryPath: tmpSource,
      outDir: compiledDir,
      pluginId: id,
    })

    // (5) Import compiled module
    let mod: Record<string, unknown>
    try {
      mod = await importCompiledModule(compileResult.outputPath)
    } catch (err) {
      throw new LoaderError('compile/import-failed', (err as Error).message)
    }

    // (6) Extract default export (cordis plugin function).
    const halfFn = (mod.default ?? (mod.apply as unknown)) as ((ctx: Context) => unknown | Promise<unknown>) | undefined
    if (typeof halfFn !== 'function') {
      throw new LoaderError('compile/no-export', 'host half must default-export a function (ctx) => ...')
    }

    // (6b) Re-upload dedup: evict any prior run of the SAME manifest id
    // before activating the new fiber, so the registry always holds
    // exactly one entry per manifest id. lifecycle.remove disposes the
    // old fiber (cordis Pages effect-chain unregisters its pages) AND
    // broadcasts `browser-half.retract { id, pluginRunId }` to connected
    // browsers so they drop the old browser half + pages. Without this
    // step, re-uploading the same zip accumulates `run-2`, `run-3`,
    // ... and the browser side's pages registry shadows new entries under
    // stale pluginRunIds. The dedup runs after manifest validation so
    // bad zips don't evict a healthy predecessor.
    const replaced: string[] = []
    for (const existing of this.deps.lifecycle.listById(id)) {
      replaced.push(existing.pluginRunId)
      await this.deps.lifecycle.remove(existing.pluginRunId)
    }

    // (7) Namespace storage BEFORE activation (v2): register the entry —
    // `lifecycle.register` kicks off the `plugin-<id>` storage domain open
    // — and await the open BEFORE loading the half into cordis, so
    // apply-time `ctx.pluginStorage` is always backed by an OPEN domain
    // (an open failure fails the load loud and evicts the entry). The
    // fiber is created afterwards and back-filled onto the entry; the
    // entry being registered first keeps the plugin attributable from
    // its first apply-time auditClient call (callerInitiator matches by
    // fiber uid).
    const pluginRunId = this.deps.lifecycle.nextRunId()
    const entry: import('./lifecycle.js').LifecycleEntry = {
      id,
      pluginRunId,
      zipPath,
      manifest,
      ...(browserSource !== undefined ? { browserSource } : {}),
    }
    this.deps.lifecycle.register(entry)
    if (entry.storagePromise) {
      try {
        await entry.storagePromise
      } catch (err) {
        // ns open failed — evict the just-registered entry before failing.
        try {
          await this.deps.lifecycle.remove(pluginRunId)
        } catch {
          // swallow — original error takes precedence
        }
        throw new LoaderError('plugin/storage-open-failed', (err as Error).message)
      }
    }

    // (8) Wrap the half so the ctx it receives carries a `pluginStorage`
    // own property: Object.create keeps the prototype chain (every cordis
    // member — registry, logger, effect, services — still resolves), and
    // the own property shadows nothing else. cordis itself is untouched.
    // Without a storage assembly (no ns opener wired — unit-test hosts,
    // embedded use), the half loads unwrapped and has no pluginStorage.
    const nsDomain = entry.storageDomain
    let wrapped: (ctx: Context, config?: { name?: string }) => unknown
    if (nsDomain) {
      wrapped = (ctx: Context, config?: { name?: string }): unknown => {
        const scoped = Object.create(ctx as object)
        // Non-enumerable own property: cordis enumerates the plugin's own
        // keys during fiber registration (inject resolution, hook wiring)
        // and rejects any key that appears across multiple fibers — keeping
        // `pluginStorage` hidden from enumeration keeps the per-fiber
        // handle fully isolated from cordis's bookkeeping while still
        // visible to the plugin half via property access.
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
    const fiber = this.deps.ctx.registry.plugin(wrapped as never, { name: id } as never) as Fiber
    ;(entry as { fiber: Fiber }).fiber = fiber
    try {
      // Wait for the plugin to settle (activation or error). `fiber.await()`
      // is a promise; we cast through unknown to avoid TS's recursive
      // thenable inference.
      await (fiber.await as unknown as () => Promise<void>)()
    } catch (err) {
      // §4.4.1 failure path: dispose the fiber and evict before rethrowing.
      try {
        await this.deps.lifecycle.remove(pluginRunId)
      } catch {
        // swallow — original error takes precedence
      }
      throw new LoaderError('plugin/runtime-error', (err as Error).message)
    }

    return {
      id,
      pluginRunId,
      manifest,
      compiledPath: compileResult.outputPath,
      zipPath,
      replaced,
      ...(browserSource !== undefined ? { browserSource } : {}),
    }
  }

  /**
   * Re-activate a previously-stopped plugin from its persisted zip.
   * Re-runs the load pipeline — the dedup step inside load() evicts the
   * stopped entry (via lifecycle.remove) before registering the fresh
   * run — so the registry holds exactly one entry per manifest id. The
   * returned pluginRunId is therefore NEW; the old one is gone.
   *
   * Only zip-uploaded plugins can be restarted (they own a `zipPath`).
   * npm-installed plugins have no persisted zip and must be re-installed
   * instead — calling start() on one throws `plugin/no-zip`.
   */
  async start(pluginRunId: string): Promise<LoadResult> {
    const entry = this.deps.lifecycle.byRunId(pluginRunId)
    if (!entry) {
      throw new LoaderError('plugin/not-found', `pluginRunId ${pluginRunId} not found`)
    }
    if (!entry.zipPath) {
      throw new LoaderError('plugin/no-zip', `plugin ${entry.id} has no persisted zip (npm-installed; reinstall instead)`)
    }
    const bytes = await readFile(entry.zipPath)
    // load() runs dedup (listById → lifecycle.remove) which evicts the
    // stopped entry before registering the fresh run.
    return this.load({ zipBytes: bytes })
  }

  /**
   * Restart: scan data-dir/plugins/*.zip and replay each through the
   * loader pipeline. Used on cold start. Each loader.load call creates
   * its own fiber — no ctx reuse is attempted.
   */
  async restartFromDataDir(): Promise<LoadResult[]> {
    const pluginsDir = join(this.deps.dataDir, 'plugins')
    let entries: string[]
    try {
      entries = await readdir(pluginsDir)
    } catch {
      return []
    }
    const results: LoadResult[] = []
    for (const name of entries) {
      if (!name.endsWith('.zip')) continue
      const path = join(pluginsDir, name)
      const bytes = await readFile(path)
      try {
        const r = await this.load({ zipBytes: bytes })
        results.push(r)
      } catch (err) {
        // Log and continue — restart is best-effort.
        // eslint-disable-next-line no-console
        console.warn(`[plugin-loader] restart failed for ${name}:`, (err as Error).message)
      }
    }
    return results
  }

  /** Best-effort cleanup of a failed-load's compiled .mjs. */
  async cleanupCompiled(compiledPath: string): Promise<void> {
    try {
      await rm(compiledPath)
    } catch {
      // ignore
    }
  }

  /**
   * Scan a workspace `plugins/` directory and load every plugin found there.
   *
   * For each subdirectory that contains a `package.json`:
   *   1. Extract id / version / manifest from package.json
   *   2. Check peer dependencies against the current host version
   *   3. Compile host.ts from the plugin path
   *   4. Persist a zip to dataDir/plugins/
   *   5. Register + activate via the standard loader pipeline
   *
   * Used by `startHost` when a workspace config declares plugins, and by
   * `loadFromLink` for a single plugin directory.
   */
  async loadFromWorkspace(dir: string): Promise<LoadResult[]> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return []
    }
    const results: LoadResult[] = []
    for (const subdir of entries) {
      const pkgPath = join(dir, subdir, 'package.json')
      try {
        await access(pkgPath)
      } catch {
        continue
      }
      try {
        const r = await this.loadFromLink(join(dir, subdir))
        results.push(r)
      } catch (err) {
        // Log and continue — workspace load is best-effort.
        // eslint-disable-next-line no-console
        console.warn(`[plugin-loader] workspace load failed for ${subdir}:`, (err as Error).message)
      }
    }
    return results
  }

  /**
   * Load a single plugin from a directory path (used by the `file:/link:` npm
   * install path, or when a workspace config declares a single plugin path).
   *
   * Reads the plugin's `package.json` directly (no npm install needed), builds
   * a minimal manifest if `api-audit` is absent, then compiles host.ts via esbuild,
   * persists a zip to `dataDir/plugins/`, and activates via `load()`.
   *
   * Peer-dependency warnings are logged and included in the returned LoadResult
   * but never block activation (npm peer semantics).
   */
  async loadFromLink(targetDir: string): Promise<LoadResult> {
    // (1) Read package.json
    let pkg: Record<string, unknown>
    try {
      const text = await readFile(join(targetDir, 'package.json'), 'utf-8')
      pkg = JSON.parse(text) as Record<string, unknown>
    } catch (err) {
      throw new LoaderError('workspace/no-package-json', `cannot read package.json in ${targetDir}: ${(err as Error).message}`)
    }

    const id = typeof pkg.name === 'string' ? basename(targetDir) : pkg.name as string
    if (!id) {
      throw new LoaderError('workspace/no-id', 'package.json has no name field and directory cannot be used as id')
    }

    const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'

    // (2) Peer dependency check: compare @flowot/nx-pn-host range against current version
    let peerWarning: string | undefined
    const peerDeps = pkg.peerDependencies as Record<string, unknown> | undefined
    if (peerDeps && typeof peerDeps['@flowot/nx-pn-host'] === 'string') {
      const range = peerDeps['@flowot/nx-pn-host'] as string
      const hostVersion = getHostVersion()
      if (!semverSatisfies(hostVersion, range)) {
        peerWarning = `plugin "${id}" declares peerDependencies @flowot/nx-pn-host:${range} which does not include current host version ${hostVersion}`
        // eslint-disable-next-line no-console
        console.warn(`[plugin-loader] ${peerWarning}`)
      }
    }

    // (3) Build a minimal manifest
    const apiAudit = pkg['api-audit'] as { manifest?: Record<string, unknown>; browser?: string } | undefined
    const rawManifest = apiAudit?.manifest as Record<string, unknown> | undefined
    let manifest: Manifest
    if (rawManifest && typeof rawManifest === 'object') {
      const browser = typeof apiAudit?.browser === 'string' ? apiAudit.browser : undefined
      const halves: { host: { entry: string }; browser?: { entry: string } } = {
        host: { entry: resolveHostEntry(pkg) },
      }
      if (browser) halves.browser = { entry: browser }
      try {
        manifest = validateManifest({
          schemaVersion: MANIFEST_VERSION,
          ...rawManifest,
          halves,
        })
      } catch (err) {
        throw new LoaderError('workspace/invalid-manifest', (err as Error).message)
      }
    } else {
      // No api-audit.manifest — build the strictest minimal manifest.
      // The plugin MUST provide host.ts or index.js as the entry point.
      const hostEntry = resolveHostEntry(pkg)
      manifest = validateManifest({
        schemaVersion: MANIFEST_VERSION,
        id,
        version,
        title: typeof pkg.description === 'string' ? pkg.description : id,
        halves: { host: { entry: hostEntry } },
      })
    }

    if (!manifest.halves.host) {
      throw new LoaderError('workspace/no-host-half', 'manifest has no host half')
    }

    // (4) Read the host source and compile via esbuild (same as zip path)
    const hostEntryName = manifest.halves.host.entry
    let hostSource: string
    try {
      hostSource = await readFile(join(targetDir, hostEntryName), 'utf-8')
    } catch (err) {
      throw new LoaderError('workspace/missing-host-entry', `host entry "${hostEntryName}" not found in ${targetDir}: ${(err as Error).message}`)
    }

    const osTmp = await realpath(tmpdir())
    const tmpSource = join(osTmp, `ws-src-${createHash('sha256').update(hostSource).digest('hex').slice(0, 16)}.ts`)
    await writeFile(tmpSource, hostSource)

    const compiledDir = join(this.deps.dataDir, 'cache', 'compiled')
    let compileResult: import('./host-compiler.js').CompileResult
    try {
      compileResult = await compileHostHalf({
        entryPath: tmpSource,
        outDir: compiledDir,
        pluginId: id,
      })
    } catch (err) {
      throw new LoaderError('workspace/compile-failed', (err as Error).message)
    }

    // (5) Build zip bytes from the compiled .mjs and manifest.json
    const zipBytes = await buildZipForLink(targetDir, compileResult.code, manifest)

    // (6) Persist zip and activate via load()
    const uploadId = randomBytes(6).toString('hex')
    const zipPath = join(this.deps.dataDir, 'plugins', `${uploadId}.zip`)
    await mkdir(dirname(zipPath), { recursive: true })
    await writeFile(zipPath, zipBytes)

    const result = await this.load({ zipBytes })

    // (7) Attach peerWarning and zipPath to result
    if (peerWarning !== undefined) {
      ;(result as { peerWarning?: string }).peerWarning = peerWarning
    }
    ;(result as { zipPath?: string }).zipPath = zipPath

    return result
  }

  /** Resolve a fresh tmp dir for tests that need one. */
  static async ensureTmpDataDir(): Promise<string> {
    // Resolve the OS temp path to its real (long) form — the short 8.3
    // name (e.g. C:\Users\MINISF~1) breaks vite/vitest's ESM loader for
    // dynamic import() of files under that directory.
    const osTmp = await realpath(tmpdir())
    const dir = join(osTmp, `api-audit-test-${randomBytes(4).toString('hex')}`)
    await mkdir(dir, { recursive: true })
    await mkdir(join(dir, 'plugins'), { recursive: true })
    await mkdir(join(dir, 'cache', 'compiled'), { recursive: true })
    return dir
  }
}

export class LoaderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

interface ExtractedManifest {
  manifest: unknown
}

/**
 * Read manifest.json from a zip file on disk. Minimal zip reader —
 * supports STORED (0) and DEFLATE (8) entries, which is what every
 * modern zip writer produces.
 */
async function extractManifestAndEntryFromZipFile(zipPath: string): Promise<ExtractedManifest> {
  const buf = await readFile(zipPath)
  const entries = readZip(buf)
  for (const e of entries) {
    if (e.name === 'manifest.json') {
      return { manifest: JSON.parse(Buffer.from(e.data).toString('utf-8')) }
    }
  }
  throw new LoaderError('zip/no-manifest', 'manifest.json missing from zip')
}

/** Read a single entry's bytes from a zip file on disk. */
async function readEntryFromZipFile(zipPath: string, entryName: string): Promise<Uint8Array> {
  const buf = await readFile(zipPath)
  const entries = readZip(buf)
  const hit = entries.find((e) => e.name === entryName)
  if (!hit) {
    throw new LoaderError('zip/missing-entry', `entry "${entryName}" missing from zip`)
  }
  return hit.data
}

interface ZipEntry {
  name: string
  data: Uint8Array
}

function readZip(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  // End of central directory record (EOCD) — last 22 bytes minimum,
  // comment adds more.
  const eocdSig = 0x06054b50
  let eocdOffset = -1
  for (let i = buf.byteLength - 22; i >= 0 && i >= buf.byteLength - 0xffff - 22; i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) {
    throw new LoaderError('zip/bad-format', 'no EOCD record found')
  }
  const cdEntries = buf.readUInt16LE(eocdOffset + 10)
  const cdSize = buf.readUInt32LE(eocdOffset + 12)
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)
  if (cdSize + cdOffset > buf.byteLength) {
    throw new LoaderError('zip/bad-format', 'central directory extends past buffer')
  }
  let p = cdOffset
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new LoaderError('zip/bad-format', 'bad central directory entry')
    }
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const fnameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localHeaderOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf-8', p + 46, p + 46 + fnameLen)
    // Read local header
    const lh = localHeaderOffset
    if (buf.readUInt32LE(lh) !== 0x04034b50) {
      throw new LoaderError('zip/bad-format', 'bad local file header')
    }
    const lhFnameLen = buf.readUInt16LE(lh + 26)
    const lhExtraLen = buf.readUInt16LE(lh + 28)
    const dataStart = lh + 30 + lhFnameLen + lhExtraLen
    const compressed = buf.subarray(dataStart, dataStart + compSize)
    let data: Uint8Array
    if (method === 0) {
      data = new Uint8Array(compressed)
    } else if (method === 8) {
      data = new Uint8Array(inflateSync(compressed))
    } else {
      throw new LoaderError('zip/unsupported-method', `unsupported method ${method}`)
    }
    entries.push({ name, data })
    p += 46 + fnameLen + extraLen + commentLen
  }
  return entries
}

// -------------------------------------------------------------- workspace helpers

/**
 * Get the current host version from package.json. Memoised so we don't
 * re-read on every plugin load.
 */
let _hostVersion: string | undefined
function getHostVersion(): string {
  if (_hostVersion !== undefined) return _hostVersion
  try {
    const text = readFileSync(join(dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json'), 'utf-8')
    const pkg = JSON.parse(text) as { version?: string }
    _hostVersion = pkg.version ?? '0.0.0'
  } catch {
    _hostVersion = '0.0.0'
  }
  return _hostVersion
}

/**
 * Minimal semver satisfying check. Handles x.y.z, ^x.y.z, ~x.y.z, >=x.y.z,
 * and ranges. Does NOT support advanced ranges (||, &&, -) — those fall
 * through to false (mismatch), which is the safe default for a warning-only
 * check.
 */
function semverSatisfies(version: string, range: string): boolean {
  const clean = (v: string) => v.replace(/^[~^>=<*\s]+/, '').trim()
  const rangeClean = range.trim()
  const op = rangeClean.match(/^[~^>=<]+/)?.[0] ?? ''
  const rangeVer = clean(rangeClean)
  const [vmaj, vmin, vpat] = version.split('.').map(Number)
  const [rmaj, rmin, rpat] = rangeVer.split('.').map(Number)
  const vmajN = vmaj ?? 0
  const vminN = vmin ?? 0
  const vpatN = vpat ?? 0
  const rmajN = rmaj ?? 0
  const rminN = rmin ?? 0
  const rpatN = rpat ?? 0

  if (op === '^') {
    return vmajN === rmajN && (vminN > rminN || (vminN === rminN && vpatN >= rpatN))
  }
  if (op === '~') {
    return vmajN === rmajN && vminN === rminN && vpatN >= rpatN
  }
  if (op === '>=') {
    return vmajN > rmajN || (vmajN === rmajN && vminN > rminN) || (vmajN === rmajN && vminN === rminN && vpatN >= rpatN)
  }
  if (op === '>') {
    return vmajN > rmajN || (vmajN === rmajN && vminN > rminN) || (vmajN === rmajN && vminN === rminN && vpatN > rpatN)
  }
  if (op === '<=') {
    return vmajN < rmajN || (vmajN === rmajN && vminN < rminN) || (vmajN === rmajN && vminN === rminN && vpatN <= rpatN)
  }
  if (op === '<') {
    return vmajN < rmajN || (vmajN === rmajN && vminN < rminN) || (vmajN === rmajN && vminN === rminN && vpatN < rpatN)
  }
  if (op === '=') {
    return version === clean(rangeClean)
  }
  // Bare version — exact match
  if (!op) {
    return version === rangeVer
  }
  return false
}

/** Resolve the host-half entry from a package.json object. */
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
  return 'host.ts'
}

/**
 * Build a zip byte array for a workspace-loaded plugin. The zip contains:
 *   - manifest.json (the validated Manifest)
 *   - <hostEntry>   (the compiled .mjs from esbuild)
 */
async function buildZipForLink(targetDir: string, compiledSource: string, manifest: Manifest): Promise<Uint8Array> {
  const manifestJson = JSON.stringify(manifest, null, 2)
  const hostEntryName = manifest.halves.host?.entry ?? 'host.mjs'

  // Collect the entries to zip: manifest.json + compiled host half
  const entries: Array<{ name: string; data: Uint8Array }> = [
    { name: 'manifest.json', data: new TextEncoder().encode(manifestJson) },
    { name: hostEntryName, data: new TextEncoder().encode(compiledSource) },
  ]

  // Zip format: STORED (no compression) for simplicity
  const parts: Uint8Array[] = []
  const offsets: number[] = []

  for (const entry of entries) {
    offsets.push(parts.reduce((s, p) => s + p.byteLength, 0))
    parts.push(zipEncodeEntry(entry.name, entry.data, 0))
  }

  const dataSize = parts.reduce((s, p) => s + p.byteLength, 0)
  const centralDirOffset = dataSize
  const centralDirParts: Uint8Array[] = []
  let cdOffset = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const off = offsets[i]!
    centralDirParts.push(zipCentralDirEntry(entry.name, entry.data.byteLength, crc32(entry.data), off))
    cdOffset += centralDirParts[centralDirParts.length - 1]!.byteLength
  }

  const eocd = zipEocd(entries.length, cdOffset, centralDirOffset)
  const all = [...parts, ...centralDirParts, eocd]
  const totalLen = all.reduce((s, p) => s + p.byteLength, 0)
  const out = new Uint8Array(totalLen)
  let pos = 0
  for (const p of all) {
    out.set(p, pos)
    pos += p.byteLength
  }
  return out
}

function zipEncodeEntry(name: string, data: Uint8Array, compressionMethod: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const header = new Uint8Array(30 + nameBytes.length)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  view.setUint32(0, 0x04034b50, true)         // local file header signature
  view.setUint16(4, 20, true)                 // version needed
  view.setUint16(6, 0, true)                  // general purpose bit flag
  view.setUint16(8, compressionMethod, true)  // compression method (0 = stored)
  view.setUint16(10, 0, true)                 // last mod time
  view.setUint16(12, 0, true)                 // last mod date
  view.setUint32(14, crc32(data), true)       // crc-32
  view.setUint32(18, data.byteLength, true)   // compressed size
  view.setUint32(22, data.byteLength, true)   // uncompressed size
  view.setUint16(24, 0, true)                 // (uncompressed size high bytes, already set above)
  view.setUint16(26, nameBytes.length, true)  // file name length
  view.setUint16(28, 0, true)                 // extra field length
  header.set(nameBytes, 30)
  const combined = new Uint8Array(header.length + data.byteLength)
  combined.set(header, 0)
  combined.set(data, header.length)
  return combined
}

function zipCentralDirEntry(name: string, size: number, crc: number, localHeaderOffset: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const header = new Uint8Array(46 + nameBytes.length)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  view.setUint32(0, 0x02014b50, true)             // signature
  view.setUint16(4, 20, true)                      // version made by
  view.setUint16(6, 20, true)                      // version needed
  view.setUint16(8, 0, true)                       // flags
  view.setUint16(10, 0, true)                      // compression method
  view.setUint16(12, 0, true)                      // mtime
  view.setUint16(14, 0, true)                      // mdate
  view.setUint32(16, crc, true)                    // crc-32
  view.setUint32(20, size, true)                   // compressed size
  view.setUint32(24, size, true)                   // uncompressed size
  view.setUint16(28, nameBytes.length, true)        // file name length
  view.setUint16(30, 0, true)                      // extra field length
  view.setUint16(32, 0, true)                      // file comment length
  view.setUint16(34, 0, true)                      // disk number start
  view.setUint16(36, 0, true)                      // internal file attributes
  view.setUint32(38, 0, true)                      // external file attributes
  view.setUint32(42, localHeaderOffset, true)       // relative offset of local header
  header.set(nameBytes, 46)
  return header
}

function zipEocd(numEntries: number, cdSize: number, cdOffset: number): Uint8Array {
  const buf = new Uint8Array(22)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(4, 0, true)
  view.setUint16(6, 0, true)
  view.setUint16(8, numEntries, true)
  view.setUint16(10, numEntries, true)
  view.setUint32(12, cdSize, true)
  view.setUint32(16, cdOffset, true)
  view.setUint16(20, 0, true)
  return buf
}

/** CRC-32 table (zlib polynomial). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[i] = c
  }
  return t
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of data) {
    crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}