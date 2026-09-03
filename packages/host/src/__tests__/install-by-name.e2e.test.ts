/**
 * Install-by-name E2E — the npx-plugin primary path, live.
 *
 * A plugin is a plain npm package: package.json carries the manifest under
 * `api-audit.manifest` and `main` points at an ESM host half. Instead of
 * zip upload + esbuild, `npmInstallPlugin` runs `npm install <file:folder>`
 * into data-dir/plugins-registry and `import()`s the host half directly.
 *
 *   1. write a minimal plugin folder (package.json + host.js)
 *   2. startHost → npmInstallPlugin({ spec: 'file:<abs>' })
 *   3. assert { id, pluginRunId, version } + lifecycle registration
 *   4. trigger `ctx.emit('demo/trigger')` → AUDIT RECORD with
 *      initiator === 'my-audit-plugin' (attribution preserved, commit 737ab2a)
 *   5. lifecycle.remove → registry empty
 *   6. re-install → fresh pluginRunId
 *   7. new host on the same dataDir → ledger replay re-installs it
 *
 * Offline-capable: the `file:` spec never touches a registry.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { startHost, type StartedHost } from '../index.js'
import { npmInstallPlugin, PLUGINS_REGISTRY_DIR } from '../plugins/installer.js'

const handles: StartedHost[] = []
const upstreams: Server[] = []
const bases: string[] = []

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.stop()
  }
  for (const s of upstreams.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
  for (const base of bases.splice(0)) {
    await rm(base, { recursive: true, force: true })
  }
})

async function makeScope(): Promise<{ dataDir: string; pluginDir: string }> {
  const osTmp = await import('node:fs/promises').then((m) => m.realpath(tmpdir()))
  const base = await mkdtemp(join(osTmp, 'api-audit-npm-e2e-'))
  bases.push(base)
  const dataDir = join(base, 'data')
  const pluginDir = join(base, 'plugin')
  await mkdir(dataDir, { recursive: true })
  return { dataDir, pluginDir }
}

async function makeHost(dataDir: string): Promise<StartedHost> {
  const host = await startHost({ port: 0, dataDir })
  handles.push(host)
  return host
}

async function makeEchoUpstream(): Promise<string> {
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ echoed: req.url, via: 'install-by-name-e2e' }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreams.push(upstream)
  const port = (upstream.address() as { port: number }).port
  return `http://127.0.0.1:${port}`
}

/** Write the minimal npm-package plugin (spec: package.json + host.js). */
async function writePluginPackage(pluginDir: string): Promise<void> {
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'package.json'),
    JSON.stringify(
      {
        name: 'my-audit-plugin',
        version: '1.2.3',
        type: 'module',
        main: './host.js',
        exports: { '.': './host.js' },
        'api-audit': {
          manifest: {
            id: 'my-audit-plugin',
            version: '1.2.3',
            title: 'My Audit Plugin',
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  )
  await writeFile(
    join(pluginDir, 'host.js'),
    [
      "const plugin = function (ctx) {",
      "  ctx.on('demo/trigger', async (payload) => {",
      "    const url = (payload && typeof payload.url === 'string') ? payload.url : 'http://127.0.0.1:1/none'",
      "    const r = await ctx.auditClient.get(url)",
      "    return r.status",
      "  })",
      "}",
      "plugin.inject = ['auditClient']",
      "export default plugin",
      '',
    ].join('\n'),
    'utf-8',
  )
}

async function waitFor<T>(pred: () => T | undefined, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = pred()
    if (hit !== undefined) return hit
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('install-by-name e2e — npm package plugin (npx-plugin path)', () => {
  it('installs a package by spec, attributes its IO, unloads, re-installs, and restarts from the ledger', async () => {
    const { dataDir, pluginDir } = await makeScope()
    await writePluginPackage(pluginDir)
    const upstreamBase = await makeEchoUpstream()

    const host = await makeHost(dataDir)
    const spec = `file:${pluginDir.replace(/\\/g, '/')}`

    // ── 1. install by name (offline file: spec) ────────────────────────
    const first = await npmInstallPlugin({ spec, dataDir, ctx: host.ctx, lifecycle: host.lifecycle })
    expect(first.id).toBe('my-audit-plugin')
    expect(first.version).toBe('1.2.3')
    expect(first.name).toBe('my-audit-plugin')
    expect(first.pluginRunId).toMatch(/^run-/)
    expect(first.manifest.halves.host.entry).toBe('./host.js')

    const entry = host.lifecycle.byRunId(first.pluginRunId)
    expect(entry).toBeDefined()
    expect(entry!.manifest.id).toBe('my-audit-plugin')
    expect(entry!.fiber.state).toBe(2) // FiberState.ACTIVE

    // ── 2. trigger the plugin tool → attributed audit record ───────────
    const toolUrl = `${upstreamBase}/demo?proof=1`
    host.ctx.emit('demo/trigger', { url: toolUrl })

    const record = await waitFor(
      () => host.buffer.snapshot().find((r) => r.initiator === 'my-audit-plugin' && r.url === toolUrl),
      5000,
      'attributed audit record',
    )
    expect(record.status).toBe(200)
    expect(record.method).toBe('GET')
    expect(record.resBody.json).toEqual({ echoed: '/demo?proof=1', via: 'install-by-name-e2e' })

    // ── 3. the npm ledger recorded the install (restart replay source) ──
    const ledgerPath = join(dataDir, PLUGINS_REGISTRY_DIR, 'installed.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf-8'))
    expect(ledger['my-audit-plugin']).toMatchObject({ spec, name: 'my-audit-plugin', version: '1.2.3' })

    // ── 4. lifecycle.remove → registry empty (ledger untouched) ────────
    await host.lifecycle.remove(first.pluginRunId)
    expect(host.lifecycle.byRunId(first.pluginRunId)).toBeUndefined()
    expect(host.lifecycle.list()).toHaveLength(0)

    // ── 5. re-install → fresh run id, tool works again ─────────────────
    const second = await npmInstallPlugin({ spec, dataDir, ctx: host.ctx, lifecycle: host.lifecycle })
    expect(second.pluginRunId).not.toBe(first.pluginRunId)
    expect(host.lifecycle.list()).toHaveLength(1)

    const toolUrl2 = `${upstreamBase}/demo-v2`
    host.ctx.emit('demo/trigger', { url: toolUrl2 })
    const record2 = await waitFor(
      () => host.buffer.snapshot().find((r) => r.initiator === 'my-audit-plugin' && r.url === toolUrl2),
      5000,
      'attributed record after re-install',
    )
    expect(record2.status).toBe(200)

    // ── 6. restart replay: a fresh host on the same dataDir reloads it ──
    await host.stop()
    handles.splice(handles.indexOf(host), 1)

    const host2 = await makeHost(dataDir)
    const replayed = host2.lifecycle.byRunId(second.pluginRunId)
    expect(replayed).toBeUndefined() // new process → new run id
    const restarted = host2.lifecycle.list().find((e) => e.id === 'my-audit-plugin')
    expect(restarted).toBeDefined()
    expect(restarted!.pluginRunId).toMatch(/^run-/)

    // attribution survives the restart too
    const toolUrl3 = `${upstreamBase}/demo-restarted`
    host2.ctx.emit('demo/trigger', { url: toolUrl3 })
    const record3 = await waitFor(
      () => host2.buffer.snapshot().find((r) => r.initiator === 'my-audit-plugin' && r.url === toolUrl3),
      5000,
      'attributed record after restart replay',
    )
    expect(record3.status).toBe(200)

    // ── 7. uninstall over REST → gone from lifecycle + npm ledger ───────
    const uninstallRes = await fetch(
      `http://127.0.0.1:${host2.port}/api/plugins/${restarted!.pluginRunId}/uninstall`,
      { method: 'POST' },
    )
    expect(uninstallRes.status).toBe(200)
    expect(host2.lifecycle.list()).toHaveLength(0)
    const ledgerAfter = JSON.parse(await readFile(ledgerPath, 'utf-8'))
    expect(ledgerAfter['my-audit-plugin']).toBeUndefined()

    // ── 8. install over REST (web UI path) → 201 + live in lifecycle ───
    const installRes = await fetch(`http://127.0.0.1:${host2.port}/api/plugins/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
    })
    expect(installRes.status).toBe(201)
    const installJson = (await installRes.json()) as { ok: boolean; data: { id: string; pluginRunId: string } }
    expect(installJson.ok).toBe(true)
    expect(installJson.data.id).toBe('my-audit-plugin')
    expect(host2.lifecycle.list()).toHaveLength(1)

    // empty spec → 400
    const badRes = await fetch(`http://127.0.0.1:${host2.port}/api/plugins/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: '   ' }),
    })
    expect(badRes.status).toBe(400)
  }, 30000)
})