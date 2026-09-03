/**
 * api-audit CLI — argument parsing + process orchestration (spec §2.2).
 *
 * `parseArgs` is pure and unit-tested; `runCli` boots the host and either
 * runs a one-shot subcommand (`add <spec>` / `uninstall <id|runId>`) or sits
 * as the long-running web server.
 *
 * The npx-plugin primary flow:
 *   npx api-audit add @scope/my-audit-plugin   # npm install-by-name
 *   npx api-audit uninstall my-plugin          # remove by id or run id
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { npmInstallPlugin, uninstallNpmPlugin, startHost, type StartedHost } from '@api-audit/host'

export const DEFAULT_PORT = 4560

export interface CliOptions {
  port: number
  dataDir: string
  /** Whether to auto-open the browser (default true; --no-open disables). */
  open: boolean
  /** Set when the first positional names a one-shot subcommand. */
  subcommand?: 'add' | 'uninstall'
  /** For `add <spec>` — npm package name/spec or file: path. */
  spec?: string
  /** For `uninstall <id|runId>` — manifest id or pluginRunId. */
  pluginId?: string
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
    if (arg.startsWith('-')) {
      throw new CliArgError(`unknown argument: ${arg} (try --help)`)
    }
    positionals.push(arg)
  }

  if (positionals.length > 0) {
    const cmd = positionals[0]!
    if (cmd === 'add') {
      opts.subcommand = 'add'
      const specArg = positionals[1]
      if (specArg === undefined || specArg === '') {
        throw new CliArgError('add requires a plugin spec (npm package name or file: path)')
      }
      opts.spec = specArg
      if (positionals.length > 2) {
        throw new CliArgError(`unexpected argument after spec: ${positionals[2]}`)
      }
    } else if (cmd === 'uninstall') {
      opts.subcommand = 'uninstall'
      const idArg = positionals[1]
      if (!idArg) {
        throw new CliArgError('uninstall requires a plugin id or pluginRunId')
      }
      opts.pluginId = idArg
      if (positionals.length > 2) {
        throw new CliArgError(`unexpected argument after id: ${positionals[2]}`)
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

Usage: api-audit [command] [options]

Commands:
  add <spec>            Install a plugin by npm package name/spec
                        (@scope/pkg, pkg@ver, or file:./folder) — npx-plugin
  uninstall <id|runId>  Stop, unload and uninstall a plugin
  (default)             Start the web server (dashboard) on --port

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
  if (opts.subcommand === 'add') {
    await runAdd(opts)
    return
  }
  if (opts.subcommand === 'uninstall') {
    await runUninstall(opts)
    return
  }
  await runServer(opts)
}

/** One-shot `api-audit add <spec>`: install by name into the live host. */
async function runAdd(opts: CliOptions): Promise<void> {
  const host: StartedHost = await startHost({ port: 0, dataDir: opts.dataDir })
  try {
    const r = await npmInstallPlugin({ spec: opts.spec!, dataDir: opts.dataDir, ctx: host.ctx, lifecycle: host.lifecycle })
    // eslint-disable-next-line no-console
    console.log(`✔ 已安装插件 ${r.id} (v${r.version}), run=${r.pluginRunId}`)
  } finally {
    await host.stop()
  }
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
    await uninstallNpmPlugin({ id: entry.id, dataDir: opts.dataDir })
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