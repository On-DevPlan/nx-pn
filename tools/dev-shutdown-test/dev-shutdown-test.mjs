#!/usr/bin/env node
/**
 * dev-shutdown-test.mjs — integration test for the Ctrl+C-clean-shutdown bug.
 *
 * Run:  node tools/dev-shutdown-test/dev-shutdown-test.mjs [devScriptPath]
 * (defaults to plugins/my-plugin/scripts/dev.mjs — the one the user is
 * hitting. Pass the template path to verify the scaffold source too.)
 *
 * Scenario:
 *   1. Spawn the dev script on an isolated port + isolated data-dir.
 *   2. Poll :PORT/api/plugins until the host reports up (or 60s timeout).
 *   3. Snapshot the dev pid and its host child pids.
 *   4. Send SIGINT to the dev script.
 *   5. Wait for the dev script to exit (timeout 15s).
 *   6. Probe :PORT again. If it still responds → host is still alive →
 *      FAIL (the bug). If it does not respond → host died → PASS.
 *   7. Also verify the dev script itself exited cleanly (no forced kill).
 *
 * Exit code 0 = pass, 1 = fail.
 */

import { spawn, execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

const devScript = process.argv[2]
  ? join(repoRoot, process.argv[2])
  : join(repoRoot, 'plugins', 'my-plugin', 'scripts', 'dev.mjs')

const PORT = 14560
const DATA_DIR = join(repoRoot, '.data', 'dev-shutdown-test')
const MAX_WAIT_MS = 60_000
const SHUTDOWN_WAIT_MS = 15_000

function log(...args) {
  console.log('[test]', ...args)
}

function probe(port) {
  return new Promise((resolve) => {
    const req = spawn('node', ['-e', `fetch('http://localhost:${port}/api/plugins', { signal: AbortSignal.timeout(1500) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))`], { stdio: 'ignore' })
    req.on('exit', (code) => resolve(code === 0))
  })
}

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

function getChildPidsWin(parentPid) {
  return new Promise((resolve) => {
    execFile('wmic', ['process', 'where', `ParentProcessId=${parentPid}`, 'get', 'ProcessId'], (err, stdout) => {
      if (err) return resolve([])
      const ids = stdout.split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l))
        .map(Number)
      resolve(ids)
    })
  })
}

async function getChildPids(parentPid) {
  if (process.platform === 'win32') return getChildPidsWin(parentPid)
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=', '-P', String(parentPid)], (err, stdout) => {
      if (err) return resolve([])
      const ids = stdout.split(/\s+/).map(Number).filter(Boolean)
      resolve(ids)
    })
  })
}

async function main() {
  log('dev script:', devScript)
  log('port:', PORT, 'data-dir:', DATA_DIR)

  // Best-effort cleanup of leftover data-dir
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch {}

  log('spawning dev.mjs ...')
  const dev = spawn('node', [devScript], {
    env: { ...process.env, NX_PN_PORT: String(PORT), NX_PN_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let devStderr = ''
  dev.stdout?.on('data', (b) => process.stdout.write('[dev.out] ' + b))
  dev.stderr?.on('data', (b) => { devStderr += b.toString() })

  // Wait for host to come up
  const ready = await waitFor(() => probe(PORT), MAX_WAIT_MS, 1000)
  if (!ready) {
    log('FAIL: host never came up within', MAX_WAIT_MS / 1000, 's')
    try { dev.kill('SIGKILL') } catch {}
    process.exit(1)
  }
  log('host is up at :' + PORT)

  // Snapshot the host child pid (best-effort)
  const childPids = await getChildPids(dev.pid)
  log('dev pid:', dev.pid, 'host child pid(s):', childPids)

  // Send SIGINT
  log('sending SIGINT to dev.pid=' + dev.pid)
  try { dev.kill('SIGINT') } catch (e) { log('kill SIGINT failed:', e.message) }

  // Wait for dev to exit
  const devExit = await new Promise((resolve) => {
    if (dev.exitCode !== null || dev.signalCode !== null) {
      resolve({ code: dev.exitCode, signal: dev.signalCode })
      return
    }
    const t = setTimeout(() => resolve({ code: null, signal: null, timeout: true }), SHUTDOWN_WAIT_MS)
    dev.once('exit', (code, signal) => {
      clearTimeout(t)
      resolve({ code, signal })
    })
  })
  log('dev exited:', devExit)

  // Give it a brief grace to release the port
  await new Promise((r) => setTimeout(r, 500))

  // Probe port — should be down
  const stillUp = await probe(PORT)
  if (stillUp) {
    log('FAIL: host is still up after dev SIGINT — port still occupied')
    log('stderr was:\n' + devStderr)
    process.exit(1)
  }

  if (devExit.timeout) {
    log('FAIL: dev did not exit within', SHUTDOWN_WAIT_MS / 1000, 's — likely hung')
    process.exit(1)
  }
  if (devExit.signal && devExit.signal !== 'SIGINT' && devExit.signal !== 'SIGTERM') {
    log('FAIL: dev was killed by signal', devExit.signal, 'instead of exiting cleanly')
    process.exit(1)
  }

  log('PASS: dev SIGINT cleanly stopped the host')
  log('  dev exit code=' + devExit.code + ' signal=' + devExit.signal)
  process.exit(0)
}

main().catch((err) => {
  console.error('[test] FATAL:', err)
  process.exit(1)
})