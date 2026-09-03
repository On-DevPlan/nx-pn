import { describe, it, expect } from 'vitest'
import { compileHostHalf } from '../plugins/host-compiler.js'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

async function makeTmp(): Promise<string> {
  const dir = join(tmpdir(), `api-audit-compile-${randomBytes(4).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  return dir
}

describe('compileHostHalf', () => {
  it('bundles valid ESM source to a .mjs file', async () => {
    const dir = await makeTmp()
    try {
      const src = join(dir, 'host.js')
      await writeFile(src, 'export default function (ctx) { ctx.foo = 1 }', 'utf-8')
      const outDir = join(dir, 'compiled')
      const result = await compileHostHalf({ entryPath: src, outDir, pluginId: 'myplug' })
      expect(result.outputPath).toMatch(/\.mjs$/)
      expect(result.contentHash).toMatch(/^[a-f0-9]+$/)
      // File actually exists
      const { stat } = await import('node:fs/promises')
      const s = await stat(result.outputPath)
      expect(s.isFile()).toBe(true)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  it('throws on invalid syntax', async () => {
    const dir = await makeTmp()
    try {
      const src = join(dir, 'host.js')
      await writeFile(src, 'this is not valid ((( syntax', 'utf-8')
      const outDir = join(dir, 'compiled')
      await expect(
        compileHostHalf({ entryPath: src, outDir, pluginId: 'bad' }),
      ).rejects.toThrow(/esbuild compile failed/)
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})