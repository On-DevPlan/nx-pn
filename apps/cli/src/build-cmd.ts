/**
 * `nx-pn build <pluginDir>` — build a plugin's deployable zip by running the
 * plugin directory's own `scripts/build-zip.mjs` (or `npm run build`).
 *
 * Each plugin owns its esbuild config (host half + browser half externals,
 * React externalisation, zip writer) in `scripts/build-zip.mjs` — the CLI
 * does not re-implement bundling, it shells out to the plugin's own build so
 * the plugin keeps full control (mirrors how the repo's nx build already
 * runs each plugin's `build` target).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliOptions } from './main.js'

export interface BuildResult {
  dir: string
  zipPath?: string
  ran: 'scripts/build-zip.mjs' | 'npm run build' | 'nx'
}

export async function runBuild(opts: CliOptions): Promise<BuildResult> {
  const dir = opts.buildDir!
  const buildZip = join(dir, 'scripts', 'build-zip.mjs')
  if (existsSync(buildZip)) {
    await runNode(join(dir, 'scripts', 'build-zip.mjs'), dir)
    return { dir, ran: 'scripts/build-zip.mjs' }
  }
  const packageJson = join(dir, 'package.json')
  if (existsSync(packageJson)) {
    // No build-zip.mjs — try `npm run build` if declared, else report clearly.
    await runCommand('npm', ['run', 'build'], dir)
    return { dir, ran: 'npm run build' }
  }
  throw new Error(`build: ${dir} has neither scripts/build-zip.mjs nor package.json (is it a plugin directory?)`)
}

/** Run one node script from the plugin dir, streaming output. */
function runNode(script: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`build-zip.mjs exited with code ${code}`))
    })
  })
}

/** Run a command from the plugin dir, streaming output. */
function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}
