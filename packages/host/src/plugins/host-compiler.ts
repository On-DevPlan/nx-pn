/**
 * esbuild compile for plugin host halves. Spec §4.4.1.
 *
 * Config: bundle, node platform, esm format, external: ['cordis'].
 * Output file name is content-hashed from metafile JSON outputs[0].hash
 * so a re-upload with new source always gets a fresh URL (avoiding the
 * Node ESM URL cache returning a stale module).
 */

import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface CompileResult {
  /** Path to the .mjs on disk. */
  outputPath: string
  /** Content hash from esbuild metafile. */
  contentHash: string
  /** Final ESM source (for in-memory inspection; loader imports the file). */
  code: string
}

export interface CompileOptions {
  /** Absolute path to the source entry (.js). */
  entryPath: string
  /** Absolute directory the compiled .mjs should land in. */
  outDir: string
  /** Optional plugin id (used for default filename). */
  pluginId?: string
}

export async function compileHostHalf(opts: CompileOptions): Promise<CompileResult> {
  await mkdir(opts.outDir, { recursive: true })

  const placeholderName = `${(opts.pluginId ?? 'plugin').replace(/[^a-z0-9_-]/gi, '_')}-tmp.mjs`
  const tmpOut = `${opts.outDir}/${placeholderName}`

  const result = await build({
    entryPoints: [opts.entryPath],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['cordis'],
    outfile: tmpOut,
    metafile: true,
    write: false,
    logLevel: 'silent',
  }).catch((err: unknown) => {
    // esbuild throws on build errors (even with write:false). Normalise to
    // a LoaderError so upload-route maps it to 422.
    const text = err instanceof Error ? err.message : String(err)
    const e = new Error(`esbuild compile failed:\n${text}`)
    e.name = 'EsbuildCompileError'
    throw e
  })

  if (result.errors.length > 0) {
    const msg = result.errors.map((e) => e.text).join('\n')
    throw new Error('esbuild compile failed:\n' + msg)
  }

  const output = result.outputFiles?.[0]
  if (!output) {
    throw new Error('esbuild produced no output files')
  }
  const code = output.text
  // The metafile.outputs hash isn't part of the public type, so read
  // through unknown and fall back to a content hash.
  const outputs = (result.metafile?.outputs ?? {}) as Record<string, { hash?: string }>
  const firstOutputHash = Object.values(outputs)[0]?.hash
  const hash =
    firstOutputHash ??
    createHash('sha256').update(code).digest('hex').slice(0, 16)
  const safeId = (opts.pluginId ?? 'plugin').replace(/[^a-z0-9_-]/gi, '_')
  const finalOut = `${opts.outDir}/${safeId}-${hash}.mjs`

  await writeFile(finalOut, code, 'utf-8')
  if (finalOut !== tmpOut) {
    // Clean up tmpOut if a different finalOut was written.
    try {
      const { unlink } = await import('node:fs/promises')
      await unlink(tmpOut)
    } catch {
      // ignore
    }
  }

  // Best-effort: drop a placeholder alongside so subsequent metafile keys
  // resolve consistently. Not strictly required.
  void dirname

  return { outputPath: finalOut, contentHash: hash, code }
}

/**
 * Import the freshly-compiled module via file:// URL — required on Windows
 * where `import(absolutePath)` fails for ESM.
 */
export function importCompiledModule(absolutePath: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(absolutePath).href
  return import(url) as Promise<Record<string, unknown>>
}