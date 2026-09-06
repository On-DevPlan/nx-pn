/**
 * dev.mjs — Monorepo root: spawn embedded base + watch + hot-reload all plugins.
 *
 * Usage (from monorepo root):
 *   node scripts/dev.mjs
 *
 * Usage (from plugins/<id>/):
 *   npm run dev   (which calls node ../../scripts/dev.mjs)
 *
 * This script:
 *   1. Resolves __root = monorepo root (scripts/ is at monorepo root level)
 *   2. localBase = apps/cli/bin/nx-pn.mjs (the built binary)
 *   3. dataDir   = .data/ under monorepo root
 *   4. Probes :4560; if down, spawns detached base process
 *   5. Waits up to 60s for base to become ready
 *   6. Watches plugins/ for .ts/.tsx/.json changes
 *   7. On change: runs build.mjs <pluginId> → hot-upload zip to running base
 */

import { spawn, execFile } from 'node:child_process'
import { watch } from 'node:fs'
import { readFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

// monorepo root = two levels up from scripts/dev.mjs
const __root = dirname(dirname(fileURLToPath(import.meta.url)))
// Built nx-pn binary
const localBase = join(__root, 'apps', 'cli', 'bin', 'nx-pn.mjs')
// Monorepo-level build script

// Detect if dev was called from a plugin subdir (plugins/<name>/).
// If so, only load that plugin — avoids loading the whole workspace
// and prevents enco from starting when developing kvlogin (and vice versa).
const __cwd = process.cwd()
const __focusPlugin = (__cwd.match(/[/\\]plugins[/\\]([^/\\]+)[/\\]?$/) || [])[1] || null
const buildScript = join(__root, 'build.mjs')

const PORT = process.env.NX_PN_PORT || 4560
const DATA_DIR = process.env.NX_PN_DATA_DIR || join(__root, '.data')
const HOST = `http://localhost:${PORT}`
const MAX_WAIT_MS = 60_000
const DEBOUNCE_MS = 500

async function probe(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/plugins`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function waitForHost(maxMs) {
  const interval = 1000
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await probe(PORT)) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

// ── Plugin rebuild + upload (hot-replace via runId dedup) ────────────────────

let building = false
let pendingRebuild = null

async function rebuildAndUpload(pluginId) {
  if (building) {
    pendingRebuild = pluginId
    return
  }
  building = true
  const t0 = Date.now()
  try {
    // Build the plugin zip via monorepo-level build.mjs
    await new Promise((resolve, reject) => {
      execFile('node', [buildScript, pluginId], { cwd: __root }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || stdout || err.message).trim()))
          return
        }
        resolve(stdout)
      })
    })

    // Upload to running base (hot-replace via dedup)
    const zipPath = join(__root, 'dist', `${pluginId}.zip`)
    const zip = await readFile(zipPath)
    const form = new FormData()
    form.append('zip', new Blob([zip]), `${pluginId}.zip`)
    const res = await fetch(`${HOST}/api/plugins`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || !json?.ok) {
      const e = json?.error
      throw new Error(`upload failed (HTTP ${res.status}${e ? `, ${e.code}: ${e.message}` : ''})`)
    }
    const replaced = Array.isArray(json.data?.replaced) && json.data.replaced.length > 0
      ? ` (replaced ${json.data.replaced.join(', ')})`
      : ''
    console.log(`[hmr] ✓ ${pluginId} → run=${json.data?.pluginRunId}${replaced} (${Date.now() - t0}ms)`)
  } catch (err) {
    console.error(`[hmr] ✗ ${pluginId}: ${err.message}`)
    if (!/ECONNREFUSED|fetch failed/i.test(err.message)) {
      console.error('      修复后保存文件自动重试')
    }
  } finally {
    building = false
    if (pendingRebuild) {
      const next = pendingRebuild
      pendingRebuild = null
      void rebuildAndUpload(next)
    }
  }
}

// ── File watcher (debounced, ignores build artifacts) ────────────────────────

const SKIP = /^(dist\/|node_modules\/|\.git\/|\.data\/|host\.js$|browser\.js$|manifest\.json$)/
const SOURCE = /\.(ts|tsx|json)$/

function startWatcher() {
  let timer
  watch(join(__root, 'plugins'), { recursive: true }, (_ev, filename) => {
    if (!filename) return
    const rel = filename.replace(/\\/g, '/')
    if (SKIP.test(rel) || !SOURCE.test(rel)) return
    // Events landing while a build is running are the build's own output
    if (building) return
    // Extract pluginId from path (first segment under plugins/)
    const pluginId = rel.split('/')[0]
    if (!pluginId || pluginId === rel) return
    // Focus mode: ignore changes to other plugins.
    if (__focusPlugin && pluginId !== __focusPlugin) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      console.log(`\n[hmr] change: ${rel}`)
      void rebuildAndUpload(pluginId)
    }, DEBOUNCE_MS)
  })
  console.log(`[hmr] watching ${join(__root, 'plugins')} (Ctrl+C to exit)`)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[dev] monorepo root: ' + __root)
  console.log('[dev] base binary:  ' + localBase)

  console.log('[dev] probing ' + HOST + ' ...')
  const alreadyUp = await probe(PORT)
  if (alreadyUp) {
    console.log('[dev] host already running at ' + HOST)
  } else {
    console.log('[dev] no host detected — spawning local nx-pn ...')

    // Ensure .data dir exists
    await mkdir(DATA_DIR, { recursive: true })

    console.log('[dev] data-dir: ' + DATA_DIR)
    if (__focusPlugin) console.log('[dev] focus: ' + __focusPlugin + ' (only this plugin will be loaded)')
    const spawnArgs = [
      localBase,
      '--no-open',
      '--port', String(PORT),
      '--data-dir', DATA_DIR,
    ]
    if (__focusPlugin) {
      // Disable workspace-config loading and only load this plugin. Also
      // skip data-dir replay so unrelated plugins uploaded earlier never
      // come back — focus means exactly one plugin on the host.
      spawnArgs.push('--no-workspace-plugins', '--no-restart', '--plugin', __focusPlugin + ':' + join(__root, 'plugins', __focusPlugin))
    }
    const child = spawn('node', spawnArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: __root,
    })
    child.unref()
    console.log('[dev] spawned pid ' + child.pid + ' (detached)')

    const ready = await waitForHost(MAX_WAIT_MS)
    if (!ready) {
      console.error('[dev] FATAL: host did not become ready within ' + (MAX_WAIT_MS / 1000) + 's')
      console.error('[dev] try running manually: node "' + localBase + '" --no-open --port ' + PORT + ' --data-dir "' + DATA_DIR + '"')
      process.exit(1)
    }
    console.log('[dev] host ready at ' + HOST)
  }

  console.log('[dev] done — connect to ' + HOST + ' in your browser')

  // Startup upload: build + hot-upload every workspace plugin once the
  // host is up. The host replays previously-uploaded zips from the data
  // dir on boot, but that replay is best-effort and a stale zip (e.g. a
  // pre-browser-half build) can leave a plugin without its browser half
  // — its pages then 404 in the shell. Re-uploading the current source
  // guarantees every plugin comes back with a complete manifest (host +
  // browser), so `npm run dev` is a closed loop: one command, working
  // plugin pages.
  const pluginsRoot = join(__root, 'plugins')
  const pluginDirs = await readdir(pluginsRoot).catch(() => [])
  for (const dir of pluginDirs) {
    // Focus mode (dev from plugins/<id>/): only this plugin is loaded.
    if (__focusPlugin && dir !== __focusPlugin) continue
    const pkgPath = join(pluginsRoot, dir, 'package.json')
    try {
      await readFile(pkgPath)
    } catch {
      continue // not a plugin package
    }
    console.log(`[dev] startup upload: ${dir}`)
    await rebuildAndUpload(dir)
  }

  // Start HMR watcher
  startWatcher()
}

main().catch((err) => {
  console.error('[dev] FATAL: ' + err.message)
  process.exit(1)
})
