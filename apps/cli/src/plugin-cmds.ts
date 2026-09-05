/**
 * `nx-pn plugin list|show|stop|remove|uninstall` — manage installed plugins
 * from the command line (automation entry point).
 *
 * Like `add`, these target a LIVE host on --port when one is running:
 * stop/remove/uninstall operate on the running host's live fiber registry,
 * which a cold-start ephemeral host cannot reach. When no host is alive the
 * mutating actions fail with a clear hint (start the host first); `list`
 * falls back to reading the durable npm ledger / installed plugins from the
 * data dir so a headless check never needs the UI up.
 */

import { startHost } from '@flowot/nx-pn-host'
import type { CliOptions } from './main.js'
import { probeHost } from './probe.js'

interface PluginRow {
  id: string
  pluginRunId: string
  title: string | undefined
  version: string | undefined
  /** npm spec when installed by name (from the ledger). */
  spec?: string
}

async function liveList(port: number): Promise<PluginRow[]> {
  const res = await fetch(`http://localhost:${port}/api/plugins`, { signal: AbortSignal.timeout(10_000) })
  if (res.status !== 200) throw new Error(`plugin list failed on live host :${port} (HTTP ${res.status})`)
  const json = (await res.json()) as {
    ok: boolean
    data?: Array<{ id: string; pluginRunId: string; manifest?: { title?: string; version?: string } }>
    error?: { message?: string }
  }
  if (!json.ok || !json.data) throw new Error(`plugin list failed on live host :${port}: ${json.error?.message ?? 'no data'}`)
  return json.data.map((p) => ({
    id: p.id,
    pluginRunId: p.pluginRunId,
    title: p.manifest?.title,
    version: p.manifest?.version,
  }))
}

async function coldList(dataDir: string): Promise<PluginRow[]> {
  const host = await startHost({ port: 0, dataDir, restartFromDataDir: true })
  try {
    return host.lifecycle.list().map((e) => ({
      id: e.id,
      pluginRunId: e.pluginRunId,
      title: e.manifest.title,
      version: e.manifest.version,
    }))
  } finally {
    await host.stop()
  }
}

/** POST to a live-host plugin action route. */
async function liveAction(port: number, path: string, what: string): Promise<void> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  })
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: { code?: string; message?: string } } | null
  if (res.status >= 300 || !json?.ok) {
    throw new Error(`${what} failed on live host :${port} (${json?.error?.code ?? 'HTTP ' + res.status}): ${json?.error?.message ?? 'no detail'}`)
  }
}

export async function runPluginList(opts: CliOptions): Promise<void> {
  let rows: PluginRow[]
  if (await probeHost(opts.port)) {
    rows = await liveList(opts.port)
  } else {
    rows = await coldList(opts.dataDir)
  }
  const format = opts.format ?? 'human'
  switch (format) {
    case 'json':
      console.log(JSON.stringify({ ok: true, count: rows.length, plugins: rows }, null, 2))
      break
    case 'jsonl':
      for (const p of rows) console.log(JSON.stringify(p))
      break
    case 'table':
    case 'human':
    default:
      if (rows.length === 0) {
        console.log('(no plugins installed)')
        break
      }
      const header = ['id', 'pluginRunId', 'title', 'version']
      const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String([r.id, r.pluginRunId, r.title ?? '', r.version ?? ''][i]!).length)))
      const pad = (s: string, w: number) => s.padEnd(w)
      console.log(header.map((h, i) => pad(h, widths[i]!)).join('  '))
      for (const r of rows) {
        console.log(pad(r.id, widths[0]!) + '  ' + pad(r.pluginRunId, widths[1]!) + '  ' + pad(r.title ?? '', widths[2]!) + '  ' + pad(r.version ?? '', widths[3]!))
      }
      break
  }
}

export async function runPluginShow(opts: CliOptions): Promise<void> {
  const target = opts.pluginTarget!
  if (await probeHost(opts.port)) {
    const rows = await liveList(opts.port)
    const hit = rows.find((p) => p.id === target || p.pluginRunId === target)
    if (!hit) throw new Error(`plugin not found: ${target} (is it installed in the live host on :${opts.port}?)`)
    console.log(JSON.stringify(hit, null, 2))
    return
  }
  const host = await startHost({ port: 0, dataDir: opts.dataDir, restartFromDataDir: true })
  try {
    const entries = host.lifecycle.list().filter((e) => e.id === target || e.pluginRunId === target)
    if (entries.length === 0) throw new Error(`plugin not found: ${target} (is it installed in ${opts.dataDir}?)`)
    console.log(JSON.stringify(entries[0]!.manifest, null, 2))
  } finally {
    await host.stop()
  }
}

export async function runPluginStop(opts: CliOptions): Promise<void> {
  const runId = opts.pluginTarget!
  if (!(await probeHost(opts.port))) {
    throw new Error(`no live host on :${opts.port} — 'plugin stop' must target a running host (start it first, then retry)`)
  }
  await liveAction(opts.port, `/api/plugins/${encodeURIComponent(runId)}/stop`, 'plugin stop')
  console.log(`✔ 已停止 ${runId} (on :${opts.port})`)
}

export async function runPluginStart(opts: CliOptions): Promise<void> {
  const runId = opts.pluginTarget!
  if (!(await probeHost(opts.port))) {
    throw new Error(`no live host on :${opts.port} — 'plugin start' must target a running host (start it first, then retry)`)
  }
  const res = await fetch(`http://localhost:${opts.port}/api/plugins/${encodeURIComponent(runId)}/start`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  })
  const json = (await res.json().catch(() => null)) as
    | { ok: boolean; data?: { pluginRunId: string; manifest?: { version?: string } }; error?: { code?: string; message?: string } }
    | null
  if (res.status >= 300 || !json?.ok) {
    throw new Error(`plugin start failed on live host :${opts.port} (${json?.error?.code ?? 'HTTP ' + res.status}): ${json?.error?.message ?? 'no detail'}`)
  }
  console.log(`✔ 已启动 ${runId} → ${json.data?.pluginRunId ?? '?'} (v${json.data?.manifest?.version ?? '?'}) (on :${opts.port})`)
}

export async function runPluginRemove(opts: CliOptions): Promise<void> {
  const runId = opts.pluginTarget!
  if (!(await probeHost(opts.port))) {
    throw new Error(`no live host on :${opts.port} — 'plugin remove' must target a running host (start it first, then retry)`)
  }
  await liveAction(opts.port, `/api/plugins/${encodeURIComponent(runId)}/remove`, 'plugin remove')
  console.log(`✔ 已移除 ${runId} (from :${opts.port})`)
}

export async function runPluginUninstall(opts: CliOptions): Promise<void> {
  const target = opts.pluginTarget!
  if (!(await probeHost(opts.port))) {
    throw new Error(`no live host on :${opts.port} — 'plugin uninstall' must target a running host (start it first, then retry)`)
  }
  await liveAction(opts.port, `/api/plugins/${encodeURIComponent(target)}/uninstall`, 'plugin uninstall')
  console.log(`✔ 已卸载 ${target} (from :${opts.port})`)
}
