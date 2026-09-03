/**
 * api-audit CLI — argument parsing + process orchestration (spec §2.2).
 *
 * `parseArgs` is pure and unit-tested; `runCli` binds the port, prints
 * the listening banner, optionally opens a browser, and shuts the host
 * down cleanly on SIGINT/SIGTERM.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { startHost, type StartedHost } from '@api-audit/host'

export const DEFAULT_PORT = 4560

export interface CliOptions {
  port: number
  dataDir: string
  /** Whether to auto-open the browser (default true; --no-open disables). */
  open: boolean
}

export class CliArgError extends Error {}

/** Parse `process.argv` tail (no node/executable entries). */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    port: DEFAULT_PORT,
    dataDir: join(homedir(), '.api-audit'),
    open: true,
  }
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
    throw new CliArgError(`unknown argument: ${arg} (try --help)`)
  }
  return opts
}

export function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`api-audit — local API audit workbench (cordis plugin platform)

Usage: api-audit [options]

Options:
  --port <n>        HTTP/WS port (default ${DEFAULT_PORT}; 0 = ephemeral)
  --data-dir <dir>  Data directory (default ~/.api-audit)
  --no-open         Do not open the browser automatically
  -h, --help        Show this help
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
