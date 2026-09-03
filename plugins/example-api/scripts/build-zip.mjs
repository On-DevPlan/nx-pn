/**
 * Build the example-api dual-half plugin zip (spec §7.1).
 *
 *   host.ts     → esbuild → dist/host.js     (node, esm, external cordis)
 *   browser.tsx → esbuild → dist/browser.js  (browser, esm, jsx automatic,
 *                                             react + cordis external)
 *   manifest.json → copied
 *   → dist/example-api.zip  (STORED entries: manifest.json, host.js, browser.js)
 *
 * Zip layout note: the host loader reads entries by exact root-relative
 * name and supports STORED (0) + DEFLATE (8) — a dependency-free STORED
 * writer keeps this script npm-dep-free beyond esbuild.
 */

import { build } from 'esbuild'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist')

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

// ── host half (spec §7.1 host.js config) ─────────────────────────────
await build({
  entryPoints: [join(root, 'host.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['cordis'],
  outfile: join(dist, 'host.js'),
  logLevel: 'silent',
})

// ── browser half (spec §7.1 browser.jsx config — shared deps stay
//    external so every half shares the app's single React instance,
//    spec §5.2.2) ──────────────────────────────────────────────────────
await build({
  entryPoints: [join(root, 'browser.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'cordis'],
  outfile: join(dist, 'browser.js'),
  logLevel: 'silent',
})

await writeFile(join(dist, 'manifest.json'), await readFile(join(root, 'manifest.json')))

// ── zip (STORED, no compression — loader-compatible) ─────────────────
const entries = [
  ['manifest.json', await readFile(join(dist, 'manifest.json'))],
  ['host.js', await readFile(join(dist, 'host.js'))],
  ['browser.js', await readFile(join(dist, 'browser.js'))],
]
const zip = makeZip(entries)
const zipPath = join(dist, 'example-api.zip')
await writeFile(zipPath, zip)

console.log(`example-api: built ${zipPath} (${zip.byteLength} bytes)`)
for (const [name, data] of entries) {
  console.log(`  ${name}: ${data.byteLength} bytes`)
}

// ── minimal STORED zip writer ────────────────────────────────────────
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
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0, 6) // flags
    lfh.writeUInt16LE(0, 8) // method: STORED
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
