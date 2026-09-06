#!/usr/bin/env node
/**
 * dev.mjs — Monorepo root: spawn embedded base + watch + hot-reload plugins.
 *
 * Two modes:
 *   - standalone (default): own host, this plugin's host
 *   - shared (--shared / NX_PN_SHARED=1): join the shared host on :4560
 *
 * Usage:
 *   cd plugins/<id> && npm run dev                    standalone
 *   cd plugins/<id> && npm run dev -- --shared       shared (join existing or create)
 *   NX_PN_SHARED=1 cd plugins/<id> && npm run dev     shared (env form)
 *
 * Implementation:
 *   1. Resolves __root = monorepo root (scripts/ is at monorepo root level)
 *   2. localBase = apps/cli/bin/nx-pn.mjs (the built binary)
 *   3. dataDir   = .data/ under monorepo root
 *   4. STANDALONE: spawn own host. If port is taken, fail loudly with guidance.
 *   5. SHARED: probe port; if a host is up, join (upload this plugin); else spawn shared.
 *   6. After host ready, instantiate @flowot/nx-pn-hmr Hmr and start watching.
 */

import { spawn, execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hmr, defaultConfig } from '@flowot/nx-pn-hmr'

// monorepo root = two levels up from scripts/dev.mjs
const __root = dirname(dirname(fileURLToPath(import.meta.url)))
// Built nx-pn binary
const localBase = join(__root, 'apps', 'cli', 'bin', 'nx-pn.mjs')
// Monorepo-level build script
const buildScript = join(__root, 'build.mjs')

// Focus plugin: when dev runs from plugins/<name>/, only that plugin is
// loaded (a standalone host is created for it, or it is the plugin this
// dev terminal owns when joining a shared host). No focus = full workspace.
const __cwd = process.cwd()
const __focusPlugin = (__cwd.match(/[/\\]plugins[/\\]([^/\\]+)[/\\]?$/) || [])[1] || null

// Shared mode: join (or create) the shared host instead of an isolated one.
const __shared = process.env.NX_PN_SHARED === '1' || process.argv.includes('--shared')

const PORT = process.env.NX_PN_PORT || 4560
const DATA_DIR = process.env.NX_PN_DATA_DIR || join(__root, '.data')
const HOST = `http://localhost:${PORT}`
const MAX_WAIT_MS = 60_000

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

async function spawnHost({ shared }) {
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
    // come back — a focused host starts clean with exactly one plugin.
    spawnArgs.push(
      '--no-workspace-plugins', '--no-restart',
      '--plugin', __focusPlugin + ':' + join(__root, 'plugins', __focusPlugin),
    )
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
    if (!shared) {
      // Standalone: port likely taken by another host. Loud guidance.
      console.error('[dev] FATAL: host did not become ready within ' + (MAX_WAIT_MS / 1000) + 's')
      console.error('[dev]   :4560 is already occupied (likely by another host):')
      console.error('[dev]     - add --shared (or NX_PN_SHARED=1) to join the existing host on :' + PORT)
      console.error('[dev]     - or set NX_PN_PORT to a free port for a standalone host')
      console.error('[dev]   manual run: node "' + localBase + '" --no-open --port ' + PORT + ' --data-dir "' + DATA_DIR + '"')
      process.exit(1)
    }
    console.error('[dev] FATAL: shared host did not become ready within ' + (MAX_WAIT_MS / 1000) + 's')
    process.exit(1)
  }
  console.log('[dev] host ready at ' + HOST)
}

async function startHmr() {
  const hmr = new Hmr(defaultConfig({
    root: join(__root, 'plugins'),
    uploadUrl: HOST + '/api/plugins',
    pluginRoot: __root,
    build: (pluginId, pluginDir) => new Promise((resolve) => {
      execFile('node', [buildScript, pluginId], { cwd: __root }, (err, stdout, stderr) => {
        resolve({ code: err ? 1 : 0, stdout: stdout || '', stderr: stderr || '' })
      })
    }),
  }))
  hmr.start()
  return hmr
}

async function main() {
  const hostUp = await probe(PORT)

  if (__shared) {
    // SHARED mode: join existing, or create if none
    if (hostUp) {
      console.log('[dev] shared host already running at ' + HOST + ' — joining')
    } else {
      console.log('[dev] no host on :' + PORT + ' — spawning shared host')
      await spawnHost({ shared: true })
    }
  } else {
    // STANDALONE mode: always own host
    if (hostUp) {
      console.error('[dev] FATAL: :' + PORT + ' already occupied by another host')
      console.error('[dev]   add --shared (or NX_PN_SHARED=1) to join it,')
      console.error('[dev]   or set NX_PN_PORT to a free port for a standalone host')
      process.exit(1)
    }
    console.log('[dev] no host detected — spawning local nx-pn ...')
    await spawnHost({ shared: false })
  }

  console.log('[dev] done — connect to ' + HOST + ' in your browser')
  await startHmr()
}

main().catch((err) => {
  console.error('[dev] FATAL:', err)
  process.exit(1)
})
