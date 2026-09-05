/**
 * api-audit CLI — argument parsing + process orchestration (spec §2.2).
 *
 * `parseArgs` is pure and unit-tested; `runCli` boots the host and either
 * runs a one-shot subcommand (`add <spec>` / `uninstall <id|runId>`) or sits
 * as the long-running web server.
 *
 * The npx-plugin primary flow:
 *   npx @flowot/nx-pn add @scope/my-audit-plugin   # npm install-by-name
 *   npx @flowot/nx-pn uninstall my-plugin          # remove by id or run id
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { npmInstallPlugin, uninstallNpmPlugin, startHost, type StartedHost } from '@flowot/nx-pn-host'
import { InitError, scaffoldPlugin } from './init.js'
import { probeHost } from './probe.js'
import { runAuditList, runAuditLastId } from './audit-cmds.js'
import { runPluginList, runPluginShow, runPluginStop, runPluginRemove, runPluginUninstall } from './plugin-cmds.js'
import { runBuild } from './build-cmd.js'

export const DEFAULT_PORT = 4560

export interface AuditQueryFlags {
  sinceId?: number
  limit?: number
  method?: string
  status?: number
  url?: string
  initiator?: string
  order?: 'asc' | 'desc'
}

export interface CliOptions {
  port: number
  dataDir: string
  /** Whether to auto-open the browser (default true; --no-open disables). */
  open: boolean
  /** Set when the first positional names a one-shot subcommand. */
  subcommand?: 'add' | 'uninstall' | 'init' | 'audit' | 'plugin' | 'build'
  /** For `add <spec>` — npm package name/spec or file: path. */
  spec?: string
  /** For `uninstall <id|runId>` — manifest id or pluginRunId. */
  pluginId?: string
  /** For `init <name>` — plugin name (must match NAME_PATTERN). */
  pluginName?: string
  /** For `init <name>` — output directory (default: ./<name>). */
  initDir?: string
  /** For `init <name>` — overwrite existing non-empty directory. */
  force?: boolean
  /** For `audit` — action: list | lastId. */
  auditAction?: 'list' | 'lastId'
  /** For `audit list` — query flags. */
  auditQuery?: AuditQueryFlags
  /** For `audit|plugin` — machine output format. */
  format?: 'json' | 'jsonl' | 'csv' | 'table' | 'human'
  /** For `plugin` — action: list | show | stop | remove | uninstall. */
  pluginAction?: 'list' | 'show' | 'stop' | 'remove' | 'uninstall'
  /** For `plugin show|stop|remove|uninstall` — target id or runId. */
  pluginTarget?: string
  /** For `build <dir>` — plugin directory. */
  buildDir?: string
}

export class CliArgError extends Error {}

/** Parse `process.argv` tail (no node/executable entries). */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    port: DEFAULT_PORT,
    dataDir: join(homedir(), '.api-audit'),
    open: true,
  }
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const takeValue = (): string => {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]
      if (inline === undefined || inline === '') {
        throw new CliArgError(`missing value for ${arg}`)
      }
      return inline
    }
    if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    }
    if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = takeValue()
      const port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new CliArgError(`--port must be an integer in [0, 65535], got ${raw}`)
      }
      opts.port = port
      continue
    }
    if (arg === '--data-dir' || arg.startsWith('--data-dir=')) {
      opts.dataDir = resolve(takeValue())
      continue
    }
    if (arg === '--no-open') {
      opts.open = false
      continue
    }
    if (arg === '--dir' || arg.startsWith('--dir=')) {
      opts.initDir = resolve(takeValue())
      continue
    }
    if (arg === '--force' || arg === '-f') {
      opts.force = true
      continue
    }
    if (arg === '--format' || arg.startsWith('--format=')) {
      const f = takeValue().toLowerCase()
      if (f !== 'json' && f !== 'jsonl' && f !== 'csv' && f !== 'table' && f !== 'human') {
        throw new CliArgError(`--format must be one of json, jsonl, csv, table, human (got ${f})`)
      }
      opts.format = f
      continue
    }
    if (arg === '--since-id' || arg.startsWith('--since-id=')) {
      opts.auditQuery ??= {}
      opts.auditQuery.sinceId = Number(takeValue())
      continue
    }
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      opts.auditQuery ??= {}
      opts.auditQuery.limit = Number(takeValue())
      continue
    }
    if (arg === '--method' || arg.startsWith('--method=')) {
      opts.auditQuery ??= {}
      opts.auditQuery.method = takeValue().toUpperCase()
      continue
    }
    if (arg === '--status' || arg.startsWith('--status=')) {
      opts.auditQuery ??= {}
      opts.auditQuery.status = Number(takeValue())
      continue
    }
    if (arg === '--url' || arg.startsWith('--url=')) {
      opts.auditQuery ??= {}
      opts.auditQuery.url = takeValue()
      continue
    }
    if (arg === '--initiator' || arg.startsWith('--initiator=')) {
      opts.auditQuery ??= {}
      opts.auditQuery.initiator = takeValue()
      continue
    }
    if (arg === '--order' || arg.startsWith('--order=')) {
      const o = takeValue()
      if (o !== 'asc' && o !== 'desc') {
        throw new CliArgError(`--order must be 'asc' or 'desc' (got ${o})`)
      }
      opts.auditQuery ??= {}
      opts.auditQuery.order = o
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliArgError(`unknown argument: ${arg} (try --help)`)
    }
    positionals.push(arg)
  }

  if (positionals.length > 0) {
    const cmd = positionals[0]!
    const second = positionals[1]
    if (cmd === 'init') {
      opts.subcommand = 'init'
      if (second === undefined || second === '') {
        throw new CliArgError('init requires a plugin name (lowercase letters, digits, hyphens)')
      }
      opts.pluginName = second
      if (positionals.length > 2) {
        throw new CliArgError(`unexpected argument after name: ${positionals[2]}`)
      }
    } else if (cmd === 'add') {
      opts.subcommand = 'add'
      if (second === undefined || second === '') {
        throw new CliArgError('add requires a plugin spec (npm package name or file: path)')
      }
      opts.spec = second
      if (positionals.length > 2) {
        throw new CliArgError(`unexpected argument after spec: ${positionals[2]}`)
      }
    } else if (cmd === 'uninstall') {
      opts.subcommand = 'uninstall'
      if (!second) {
        throw new CliArgError('uninstall requires a plugin id or pluginRunId')
      }
      opts.pluginId = second
      if (positionals.length > 2) {
        throw new CliArgError(`unexpected argument after id: ${positionals[2]}`)
      }
    } else if (cmd === 'audit') {
      opts.subcommand = 'audit'
      if (second === 'lastId') {
        opts.auditAction = 'lastId'
        if (positionals.length > 2) {
          throw new CliArgError(`unexpected argument after 'audit lastId': ${positionals[2]}`)
        }
      } else if (second === undefined || second === 'list') {
        opts.auditAction = 'list'
        if (positionals.length > 2) {
          throw new CliArgError(`unexpected argument after 'audit list': ${positionals[2]}`)
        }
      } else {
        throw new CliArgError(`unknown audit action: ${second} (expected list or lastId)`)
      }
    } else if (cmd === 'plugin') {
      opts.subcommand = 'plugin'
      const actions = ['list', 'show', 'stop', 'remove', 'uninstall'] as const
      if (!second || !(actions as readonly string[]).includes(second)) {
        throw new CliArgError(`plugin requires an action: ${actions.join(' | ')} (got ${second ?? 'nothing'})`)
      }
      opts.pluginAction = second as (typeof actions)[number]
      if (second === 'list') {
        if (positionals.length > 2) {
          throw new CliArgError(`unexpected argument after 'plugin list': ${positionals[2]}`)
        }
      } else {
        const target = positionals[2]
        if (!target) {
          throw new CliArgError(`plugin ${second} requires a plugin id or runId`)
        }
        opts.pluginTarget = target
        if (positionals.length > 3) {
          throw new CliArgError(`unexpected argument after target: ${positionals[3]}`)
        }
      }
    } else if (cmd === 'build') {
      opts.subcommand = 'build'
      if (!second) {
        throw new CliArgError('build requires a plugin directory (e.g. ./plugins/echo)')
      }
      opts.buildDir = resolve(second)
      if (positionals.length > 2) {
        throw new CliArgError(`unexpected argument after build dir: ${positionals[2]}`)
      }
    } else {
      throw new CliArgError(`unknown argument: ${cmd} (try --help)`)
    }
  }
  return opts
}

export function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`api-audit — local API audit workbench (cordis plugin platform)

Usage: nx-pn [command] [options]        (npx @flowot/nx-pn <command>)

Commands:
  init <name>             Scaffold a new plugin (writes 8 template files)
                          [--dir <path>] [--force]
  add <spec>              Install a plugin by npm package name/spec
                          (@scope/pkg, pkg@ver, or file:./folder) — npx-plugin.
                          Forwards to a live host on --port (hot-add) when one
                          is running; otherwise writes the npm ledger (takes
                          effect on the next host start)
  uninstall <id|runId>    Stop, unload and uninstall a plugin
  audit list              Print audit records as JSON/JSONL/CSV
                          [--since-id N] [--limit N] [--method M]
                          [--status S] [--url SUBSTR] [--initiator I]
                          [--order asc|desc] [--format json|jsonl|csv|table|human]
  audit lastId            Print the latest audit record id (cheap polling)
  plugin list             List installed plugins
                          [--format json|jsonl|csv|table|human]
  plugin show <id|runId>  Show one plugin's manifest (JSON)
  plugin stop <runId>     Stop a running plugin (fiber.dispose)
  plugin remove <runId>   Stop + evict from the lifecycle registry
  plugin uninstall <id>   Remove + drop from the npm ledger
  build <pluginDir>       Build a plugin's zip (runs its scripts/build-zip.mjs)
  (default)               Start the web server (dashboard) on --port

Options:
  --port <n>            HTTP/WS port (default ${DEFAULT_PORT}; 0 = ephemeral)
  --data-dir <dir>      Data directory (default ~/.api-audit)
  --no-open             Do not open the browser automatically
  -h, --help            Show this help
`)
}

/** Open the OS browser at `url` (fire-and-forget). */
export function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd builtin, not an executable.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    // best-effort only
  }
}

/** Boot the host, install signal handlers, and block until stopped. */
export async function runCli(argv: string[]): Promise<void> {
  const opts = parseArgs(argv)
  if (opts.subcommand === 'init') {
    await runInit(opts)
    return
  }
  if (opts.subcommand === 'add') {
    await runAdd(opts)
    return
  }
  if (opts.subcommand === 'uninstall') {
    await runUninstall(opts)
    return
  }
  if (opts.subcommand === 'audit') {
    if (opts.auditAction === 'lastId') {
      await runAuditLastId(opts)
    } else {
      await runAuditList(opts)
    }
    return
  }
  if (opts.subcommand === 'plugin') {
    switch (opts.pluginAction) {
      case 'list':
        await runPluginList(opts)
        break
      case 'show':
        await runPluginShow(opts)
        break
      case 'stop':
        await runPluginStop(opts)
        break
      case 'remove':
        await runPluginRemove(opts)
        break
      case 'uninstall':
        await runPluginUninstall(opts)
        break
    }
    return
  }
  if (opts.subcommand === 'build') {
    const result = await runBuild(opts)
    console.log(`✔ 已构建 ${result.dir} (via ${result.ran})`)
    return
  }
  await runServer(opts)
}

/** One-shot `api-audit add <spec>`: install by name into the live host.
 *
 * Spec forms:
 *   - `name`, `name@ver`, `@scope/name`  → npm install-by-name
 *   - `file:./dir`                       → npm install of a local package dir
 *   - `file:./dist/x.zip`, `./x.zip`     → dual-half zip upload (the zip path
 *                                          the Plugins page uses; loader.load)
 */
async function runAdd(opts: CliOptions): Promise<void> {
  // Zip spec? Strip an optional file: prefix, then test the extension.
  const rawSpec = opts.spec!
  const specPath = rawSpec.startsWith('file:') ? rawSpec.slice(5) : (rawSpec.match(/\.zip$/) ? rawSpec : undefined)
  if (specPath && /\.zip$/i.test(specPath)) {
    await runAddZip(opts, resolve(specPath))
    return
  }

  // Probe for a long-running host first: alive → forward the install REST
  // route so the plugin hot-adds (and hot-updates) into the running host
  // (eating the installer's upsert semantics); not alive → fall back to the
  // ephemeral one-shot path, which only writes the npm ledger and takes
  // effect on the next host start (restartNpmPlugins).
  const alive = await probeHost(opts.port)
  if (alive) {
    const forwarded = await forwardInstall(opts.port, opts.spec!)
    // eslint-disable-next-line no-console
    console.log(`✔ 已安装插件 ${forwarded.id} (v${forwarded.version}) 到运行中的 host :${opts.port}, run=${forwarded.pluginRunId}`)
    // eslint-disable-next-line no-console
    console.log(`  (热添加已生效 — 无需重启;浏览器侧边栏即时更新)`)
    return
  }
  const host: StartedHost = await startHost({ port: 0, dataDir: opts.dataDir })
  try {
    const r = await npmInstallPlugin({ spec: opts.spec!, dataDir: opts.dataDir, ctx: host.ctx, lifecycle: host.lifecycle, pluginsDomain: host.pluginsDomain })
    // eslint-disable-next-line no-console
    console.log(`✔ 已安装插件 ${r.id} (v${r.version}), run=${r.pluginRunId}`)
    // eslint-disable-next-line no-console
    console.log(`  (ledger 路径 — 下次 host 启动时生效;当前无运行中的 host :${opts.port})`)
  } finally {
    await host.stop()
  }
}

/** `add <*.zip>`: upload a dual-half zip. Live host → POST /api/plugins
 * (multipart, same route the Plugins page uses — hot-add + browser push);
 * cold → ephemeral host + loader.load. Zip plugins are not in the npm
 * ledger; restarts replay them from dataDir/plugins/. */
async function runAddZip(opts: CliOptions, zipPath: string): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const zipBytes = new Uint8Array(await readFile(zipPath))
  if (await probeHost(opts.port)) {
    const form = new FormData()
    form.append('zip', new Blob([zipBytes]), 'plugin.zip')
    const res = await fetch(`http://localhost:${opts.port}/api/plugins`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; data?: { id: string; pluginRunId: string; manifest?: { version?: string } }; error?: { code?: string; message?: string } }
      | null
    if (res.status >= 300 || !json?.ok || !json.data) {
      throw new Error(`zip 上传失败 (HTTP ${res.status}${json?.error ? `, ${json.error.code}: ${json.error.message}` : ''})`)
    }
    // eslint-disable-next-line no-console
    console.log(`✔ 已上传插件 ${json.data.id} (v${json.data.manifest?.version ?? '?'}) 到运行中的 host :${opts.port}, run=${json.data.pluginRunId}`)
    return
  }
  const host: StartedHost = await startHost({ port: 0, dataDir: opts.dataDir })
  try {
    const r = await host.loader.load({ zipBytes })
    // eslint-disable-next-line no-console
    console.log(`✔ 已加载插件 ${r.id} (v${r.manifest.version}), run=${r.pluginRunId}`)
    // eslint-disable-next-line no-console
    console.log(`  (zip 已存入 dataDir/plugins/ — host 下次启动时重放)`)
  } finally {
    await host.stop()
  }
}

/**
 * Forward `spec` to a live host's `POST /api/plugins/install` route —
 * the host hot-adds (or hot-updates, upsert) the plugin without restart,
 * and pushes the browser half to every connected web shell.
 */
export async function forwardInstall(port: number, spec: string): Promise<{ id: string; pluginRunId: string; version: string }> {
  const res = await fetch(`http://localhost:${port}/api/plugins/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spec }),
    signal: AbortSignal.timeout(60000),
  })
  const json = (await res.json()) as { ok: boolean; data?: { id: string; pluginRunId: string; version?: string }; error?: { code: string; message: string } }
  if (!res.status.toString().startsWith('2') || !json.ok || !json.data) {
    const err = json.error
    throw new Error(`install failed on live host :${port} (${err?.code ?? 'unknown'}): ${err?.message ?? json.data?.id ?? 'no data'}`)
  }
  return { id: json.data.id, pluginRunId: json.data.pluginRunId, version: json.data.version ?? json.data.id }
}

/** One-shot `api-audit init <name>`: scaffold an 8-file plugin directory. */
async function runInit(opts: CliOptions): Promise<void> {
  const dir = opts.initDir ?? join(process.cwd(), opts.pluginName!)
  const result = await scaffoldPlugin({
    name: opts.pluginName!,
    dir,
    force: opts.force ?? false,
  })
  // eslint-disable-next-line no-console
  console.log(`✔ 已生成 ${result.dir} (${result.files.length} 个文件)`)
  for (const f of result.files) {
    // eslint-disable-next-line no-console
    console.log(`    - ${f}`)
  }
  // eslint-disable-next-line no-console
  console.log('')
  // eslint-disable-next-line no-console
  console.log('下一步:')
  // eslint-disable-next-line no-console
  console.log(`  cd ${result.dir}`)
  // eslint-disable-next-line no-console
  console.log('  npm install')
  // eslint-disable-next-line no-console
  console.log('  npm run build')
  // eslint-disable-next-line no-console
  console.log('  npx @flowot/nx-pn add file:.')
}

/** One-shot `api-audit uninstall <id|runId>`: stop + unload + drop ledger. */
async function runUninstall(opts: CliOptions): Promise<void> {
  const host: StartedHost = await startHost({ port: 0, dataDir: opts.dataDir })
  try {
    const target = opts.pluginId!
    const entry = host.lifecycle.byRunId(target) ?? host.lifecycle.list().find((e) => e.id === target)
    if (!entry) {
      throw new CliArgError(`plugin not found: ${target} (is it installed in ${opts.dataDir}?)`)
    }
    await host.lifecycle.remove(entry.pluginRunId)
    await uninstallNpmPlugin({ id: entry.id, dataDir: opts.dataDir, pluginsDomain: host.pluginsDomain })
    // eslint-disable-next-line no-console
    console.log(`✔ 已卸载插件 ${entry.id} (run=${entry.pluginRunId})`)
  } finally {
    await host.stop()
  }
}

/** The default web-server command. */
async function runServer(opts: CliOptions): Promise<void> {
  const host: StartedHost = await startHost({ port: opts.port, dataDir: opts.dataDir })
  // eslint-disable-next-line no-console
  console.log(`api-audit listening on http://localhost:${host.port} (data dir: ${host.dataDir})`)

  if (opts.open) {
    openBrowser(`http://localhost:${host.port}`)
  }

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    // eslint-disable-next-line no-console
    console.log(`\napi-audit: received ${signal}, shutting down…`)
    void host.stop().then(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Block until a signal arrives.
  await new Promise<never>(() => {})
}