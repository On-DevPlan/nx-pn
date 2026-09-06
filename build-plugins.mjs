/**
 * build.mjs — Build a single plugin from plugins/<pluginId>/ into dist/<pluginId>.zip.
 */

import { build } from 'esbuild'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = scriptDir
const pluginId = process.argv[2]
if (!pluginId) {
  console.error('usage: node build.mjs <pluginId>')
  process.exit(1)
}

const pluginDir = join(root, 'plugins', pluginId)
const outDir = join(root, 'dist')

// ── 1. Read plugin sources ────────────────────────────────────────────────────
const [hostSrc, browserSrc, manifestRaw] = await Promise.all([
  readFile(join(pluginDir, 'host.ts'), 'utf-8'),
  readFile(join(pluginDir, 'browser.tsx'), 'utf-8'),
  readFile(join(pluginDir, 'manifest.json'), 'utf-8'),
])

// ── 2. Build host.js ──────────────────────────────────────────────────────────
await build({
  entryPoints: [join(pluginDir, 'host.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['cordis'],
  outfile: join(pluginDir, 'host.js'),
  logLevel: 'silent',
})

// ── 3. Build browser.js ───────────────────────────────────────────────────────
await build({
  entryPoints: [join(pluginDir, 'browser.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'react-router-dom', 'cordis'],
  outfile: join(pluginDir, 'browser.js'),
  logLevel: 'silent',
})

// ── 4. Defensive check: cordis must not be bundled ────────────────────────────
const compiledHost = await readFile(join(pluginDir, 'host.js'), 'utf-8')
if (/from\s*["']cordis["']/.test(compiledHost) || /require\s*\(["']cordis["']/.test(compiledHost)) {
  throw new Error(`${pluginId}: cordis leaked into host.js bundle — check externals`)
}
const compiledBrowser = await readFile(join(pluginDir, 'browser.js'), 'utf-8')
if (/from\s*["']cordis["']/.test(compiledBrowser) || /require\s*\(["']cordis["']/.test(compiledBrowser)) {
  throw new Error(`${pluginId}: cordis leaked into browser.js bundle — check externals`)
}
if (!/from\s*["']react["']/.test(compiledBrowser)) {
  throw new Error(`${pluginId}: compiled browser.js must keep React external`)
}

// ── 5. Assemble STORED zip ────────────────────────────────────────────────────
await mkdir(outDir, { recursive: true })

const entries = [
  ['manifest.json', Buffer.from(manifestRaw, 'utf-8')],
  ['host.js', await readFile(join(pluginDir, 'host.js'))],
  ['browser.js', await readFile(join(pluginDir, 'browser.js'))],
]

const zip = makeZip(entries)
const zipPath = join(outDir, `${pluginId}.zip`)
await writeFile(zipPath, zip)

console.log(`${pluginId}: built ${zipPath} (${zip.byteLength} bytes)`)
for (const [name, data] of entries) {
  console.log(`  zip[${name}]: ${data.length} bytes`)
}

// ── helpers (same algorithm as loader.ts:346-399) ─────────────────────────────
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.byteLength; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(parts) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, data] of parts) {
    const nameBuf = Buffer.from(name, 'utf-8')
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0, 6)
    lfh.writeUInt16LE(0, 8)
    lfh.writeUInt32LE(crc32(data), 14)
    lfh.writeUInt32LE(data.byteLength, 18)
    lfh.writeUInt32LE(data.byteLength, 22)
    lfh.writeUInt16LE(nameBuf.byteLength, 26)
    local.push(lfh, nameBuf, data)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt32LE(crc32(data), 16)
    cdh.writeUInt32LE(data.byteLength, 20)
    cdh.writeUInt32LE(data.byteLength, 24)
    cdh.writeUInt16LE(nameBuf.byteLength, 28)
    cdh.writeUInt32LE(offset, 42)
    central.push(cdh, nameBuf)
    offset += 30 + nameBuf.byteLength + data.byteLength
  }
  const localBuf = Buffer.concat(local)
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(parts.length, 8)
  eocd.writeUInt16LE(parts.length, 10)
  eocd.writeUInt32LE(cdBuf.byteLength, 12)
  eocd.writeUInt32LE(localBuf.byteLength, 16)
  return Buffer.concat([localBuf, cdBuf, eocd])
}
