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

import { mkdir, writeFile, rm, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import type { Context, Fiber } from '../cordis/cordis-shim.js'
import {
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