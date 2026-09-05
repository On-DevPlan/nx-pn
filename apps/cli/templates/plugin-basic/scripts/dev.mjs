/**
 * {{title}} — plugin dev watch loop.
 *
 *   npm run dev [-- --port 4560] [-- --data-dir <path>]
 *
 * Watches host.ts / browser.tsx / src/** / package.json. On any change:
 *   rebuild the zip → hot-upload to the running host → done.
 *
 * Why this works without a page refresh: the host pushes the new browser
 * half to every connected web shell as a `browser-half.load` WS frame, so
 * the plugin UI swaps live. The host half is replaced by runId dedup
 * (old fiber disposed, new run registered) — no host restart either.
 *
 * If no host answers on --port, one is started automatically:
 *   - NX_PN_HOST_CMD (explicit launch command) if set — bring your own
 *     --port/--data-dir inside it
 *   - otherwise `npx --yes @flowot/nx-pn --no-open --port <n> [--data-dir <d>]`
 *
 * Only two assumptions: the host is up on --port (default 4560) and the
 * upload endpoint answers POST /api/plugins with multipart zip.
 */

import { watch } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const zipPath = join(root, 'dist', '{{id}}.zip')

// --port <n> / --data-dir <path> (also accepts --key=value)
let port = 4560
let dataDir = null
{
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port' || a.startsWith('--port=')) {
      const raw = a.includes('=') ? a.slice('--port='.length) : argv[++i]
      const n = Number(raw)
      if (Number.isInteger(n) && n > 0 && n < 65536) port = n
      else console.warn(`[dev] ignoring invalid --port ${raw}, using ${port}`)
    } else if (a === '--data-dir' || a.startsWith('--data-dir=')) {
      dataDir = a.includes('=') ? a.slice('--data-dir='.length) : argv[++i]
    }
  }
}

const UPLOAD_URL = `http://localhost:${port}/api/plugins`

/** Run the plugin's own build (tsc typecheck + esbuild + zip). */
function build() {
  return new Promise((resolve, reject) => {
    execFile('node', ['scripts/build-zip.mjs'], { cwd: root }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || stdout || err.message).trim()))
        return
      }
      if (stdout.trim()) console.log(stdout.trim())
      resolve()
    })
  })
}

/** Hot-upload the built zip to the running host. Returns run data. */
async function upload() {
  const zip = await readFile(zipPath)
  const form = new FormData()
  form.append('zip', new Blob([zip]), '{{id}}.zip')
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.ok || !json.data) {
    const e = json?.error
    throw new Error(`upload failed (HTTP ${res.status}${e ? `, ${e.code}: ${e.message}` : ''})`)
  }
  return json.data
}

let building = false
let pending = false

/** Is a host answering on the upload port? */
async function probeHost() {
  try {
    const res = await fetch(UPLOAD_URL, { method: 'GET', signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function waitForHost(timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await probeHost()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/**
 * Make sure a host is running before the first upload. If none answers on
 * --port, start one:
 *   - NX_PN_HOST_CMD (explicit, e.g. a monorepo dev entry) if set
 *   - otherwise `npx --yes @flowot/nx-pn --no-open`
 * Then poll until it answers (25s budget).
 */
async function ensureHost() {
  if (await probeHost()) {
    console.log(`[dev] 已连接运行中的 web（:${port}）`)
    return
  }
  const cmd = process.env.NX_PN_HOST_CMD
  if (cmd) {
    console.log(`[dev] 检测到 web 未运行，启动底座: ${cmd}`)
    spawn(cmd, { shell: true, detached: true, stdio: 'ignore' }).unref()
  } else {
    const args = ['--yes', '@flowot/nx-pn', '--no-open', '--port', String(port)]
    if (dataDir) args.push('--data-dir', dataDir)
    console.log(`[dev] 检测到 web 未运行，npx 启动 @flowot/nx-pn: ${args.slice(1).join(' ')}`)
    spawn('npx', args, { shell: true, detached: true, stdio: 'ignore' }).unref()
  }
  if (await waitForHost(25_000)) {
    console.log(`[dev] 底座已就绪（:${port}）`)
    return
  }
  console.warn('[dev] ⚠ 底座 25s 内未就绪 — 请手动启动底座后重试；或设置 NX_PN_HOST_CMD 指定启动命令')
}

/** One dev cycle: rebuild → upload → report. Serialized (no overlap). */
async function cycle(reason) {
  if (building) {
    pending = true
    return
  }
  building = true
  const t0 = Date.now()
  try {
    console.log(`\n[dev] ${reason}`)
    await build()
    const data = await upload()
    const replaced = Array.isArray(data.replaced) && data.replaced.length
      ? ` replaced=${JSON.stringify(data.replaced)}`
      : ''
    console.log(`[dev] ✓ run=${data.pluginRunId}${replaced} (${Date.now() - t0}ms) — 页面已自动推送，无需刷新`)
  } catch (err) {
    console.error(`[dev] ✗ ${err.message}`)
    if (!/ECONNREFUSED|fetch failed/i.test(err.message)) {
      console.error('      修复后保存任意源文件即可重试（或 Ctrl+C 退出）')
    } else {
      console.error(`      底座不在线 — 请先启动底座（npx @flowot/nx-pn 或 node apps/cli/bin/nx-pn.mjs），保存文件自动续传`)
    }
  } finally {
    building = false
    if (pending) {
      pending = false
      void cycle('queued change')
    }
  }
}

// Watch source roots; ignore generated artifacts (host.js/browser.js/
// manifest.json land at the package root, dist/ and node_modules/ too).
const SKIP = /^(dist\/|node_modules\/|\.git\/|host\.js$|browser\.js$|manifest\.json$)/
const SOURCE = /\.(ts|tsx|json)$/

let timer
watch(root, { recursive: true }, (_ev, name) => {
  if (!name) return
  const rel = name.replace(/\\/g, '/')
  if (SKIP.test(rel) || !SOURCE.test(rel)) return
  // Events landing while a cycle is running are the build's own output
  // (host.js / browser.js / manifest.json / dist writes) — drop them so
  // each real edit triggers exactly one cycle.
  if (building) return
  clearTimeout(timer)
  timer = setTimeout(() => void cycle(`change: ${rel}`), 400)
})

console.log(`[dev] watching ${root}`)
console.log(`[dev] upload target: ${UPLOAD_URL} (Ctrl+C to exit)\n`)

// Make sure a host is up, then do the initial build+upload so a fresh
// `npm run dev` starts from a loaded state.
await ensureHost()
void cycle('startup')
