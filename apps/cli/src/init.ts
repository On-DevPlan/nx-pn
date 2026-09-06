/**
 * Plugin scaffolder for `npx @flowot/nx-pn init <name>` (spec §).
 * Pure functions: validateName / nameToTitle / nameToPath / nameToComponent /
 * renderTemplate. I/O lives in scaffoldPlugin.
 *
 * Phase 1: generates a workspace template at plugins/<id>/ containing the plugin,
 * with the workspace root holding shared scripts, tsconfig, and package.json.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile as readJsonFile } from 'node:fs/promises'

export class InitError extends Error {}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const PATH_PATTERN = /^\/[a-zA-Z0-9_\-\/.:]*$/

export interface InitOptions {
  name: string
  dir: string
  force: boolean
}

export interface InitResult {
  dir: string
  files: string[]
}

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new InitError(
      'invalid plugin name: "' + name + '" (must match ' + NAME_PATTERN.source + ', lowercase letters/digits/hyphens, 1-64 chars, starting with letter or digit)',
    )
  }
  if (name.endsWith('-')) {
    throw new InitError('invalid plugin name: "' + name + '" (must not end with a hyphen)')
  }
}

export function nameToTitle(name: string): string {
  return name
    .split('-')
    .map((s) => (s.length === 0 ? '' : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(' ')
}

export function nameToPath(name: string): string {
  const p = '/' + name
  if (!PATH_PATTERN.test(p)) {
    throw new InitError('derived path invalid: ' + p)
  }
  return p
}

export function nameToComponent(name: string): string {
  return name
    .split('-')
    .map((s) => (s.length === 0 ? '' : s.charAt(0).toUpperCase() + s.slice(1)))
    .join('')
}

export function renderTemplate(src: string, vars: Record<string, string>): string {
  // \w doesn't match '-', so we explicitly include it in the key char class.
  // Without this, keys like `user-agent` would not be recognized and would
  // leak through to the output as the literal `{{user-agent}}`.
  return src.replace(/\{\{([\w-]+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new InitError('template variable not provided: ' + key)
    }
    return vars[key] as string
  })
}

/**
 * Locate the template directory. Compiled code lives at apps/cli/lib/init.js,
 * templates at apps/cli/templates/plugin-workspace/. Falls back to cwd-based
 * resolution during development (no lib/ yet).
 */
async function locateTemplateDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'templates', 'plugin-workspace'),
    join(process.cwd(), 'apps', 'cli', 'templates', 'plugin-workspace'),
  ]
  for (const dir of candidates) {
    try {
      await readFile(join(dir, 'package.json'), 'utf-8')
      return dir
    } catch {
      // try next
    }
  }
  throw new InitError('cannot locate templates/plugin-workspace (tried: ' + candidates.join(', ') + ')')
}

/**
 * Read the CLI version from apps/cli/package.json so we can inject it as
 * the {{version}} placeholder. This makes scaffolded workspaces pin to the
 * same nx-pn version that generated them.
 */
async function getCliVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'package.json'),
    join(process.cwd(), 'apps', 'cli', 'package.json'),
  ]
  for (const path of candidates) {
    try {
      const raw = await readJsonFile(path, 'utf-8')
      const pkg = JSON.parse(raw)
      if (pkg.version) return pkg.version
    } catch {
      // try next
    }
  }
  // Fallback — should never reach here in practice
  return '0.0.0'
}

export async function scaffoldPlugin(opts: InitOptions): Promise<InitResult> {
  validateName(opts.name)
  const title = nameToTitle(opts.name)
  const path = nameToPath(opts.name)
  const componentName = nameToComponent(opts.name)
  const version = await getCliVersion()

  // workspaceName: the top-level workspace dir name (the user's chosen name)
  // pluginId: the plugin subdir name under plugins/ (same as workspaceName for v1)
  const workspaceName = opts.name
  const pluginId = opts.name

  const vars: Record<string, string> = {
    id: opts.name,
    workspaceName,
    pluginId,
    title,
    path,
    pageComponentName: componentName,
    version,
    description: 'Scaffolded nx-pn plugin: ' + title,
    'user-agent': 'nx-pn-' + opts.name + '/0.0.1',
  }

  const templateDir = await locateTemplateDir()

  // Workspace root files
  const rootFiles = [
    'package.json',
    'tsconfig.json',
    'scripts/dev.mjs',
    'scripts/build.mjs',
  ]

  // Plugin subdir files (under plugins/<pluginId>/)
  const pluginFiles = [
    'package.json',
    'tsconfig.json',
    'manifest.json',
    'host.ts',
    'browser.tsx',
  ]

  // Check dest — refuse non-empty unless --force
  let existed = false
  try {
    await readFile(join(opts.dir, 'package.json'), 'utf-8')
    existed = true
  } catch {
    existed = false
  }
  if (existed && !opts.force) {
    throw new InitError('directory already exists and is non-empty: ' + opts.dir + ' (use --force to overwrite)')
  }
  await rm(opts.dir, { recursive: true, force: true })
  await mkdir(opts.dir, { recursive: true })

  // ── 1. Create workspace root structure ─────────────────────────────────────
  await mkdir(join(opts.dir, 'scripts'), { recursive: true })
  await mkdir(join(opts.dir, 'plugins', pluginId), { recursive: true })

  const written: string[] = []

  for (const f of rootFiles) {
    const src = await readFile(join(templateDir, f), 'utf-8')
    const dst = join(opts.dir, f)
    const rendered = renderTemplate(src, vars)
    await writeFile(dst, rendered, 'utf-8')
    written.push(f)
  }

  // ── 2. Create plugin subdir structure ──────────────────────────────────────
  for (const f of pluginFiles) {
    const src = await readFile(join(templateDir, 'plugins', '{{pluginId}}', f), 'utf-8')
    const dst = join(opts.dir, 'plugins', pluginId, f)
    const rendered = renderTemplate(src, vars)
    await writeFile(dst, rendered, 'utf-8')
    written.push('plugins/' + pluginId + '/' + f)
  }

  return { dir: opts.dir, files: written }
}

/**
 * Scaffold a new plugin INTO an existing workspace's plugins/ dir.
 * Equivalent to koishi's `npm run new` — adds a plugin subdir without
 * touching workspace root files (package.json, tsconfig, scripts).
 *
 * Also appends the plugin entry to koishi.config.yml (creates the file if absent).
 */
export async function scaffoldPluginInWorkspace(opts: {
  name: string
  workspaceDir: string
}): Promise<InitResult> {
  validateName(opts.name)
  const title = nameToTitle(opts.name)
  const version = await getCliVersion()
  const pluginId = opts.name
  const vars: Record<string, string> = {
    id: opts.name,
    workspaceName: pluginId,
    pluginId,
    title,
    path: nameToPath(opts.name),
    pageComponentName: nameToComponent(opts.name),
    version,
    description: 'Scaffolded nx-pn plugin: ' + title,
    'user-agent': 'nx-pn-' + opts.name + '/0.0.1',
  }

  const templateDir = await locateTemplateDir()

  // Verify workspace exists (has package.json)
  try {
    await readFile(join(opts.workspaceDir, 'package.json'), 'utf-8')
  } catch {
    throw new InitError('workspace directory has no package.json: ' + opts.workspaceDir + ' (run init first)')
  }

  // Refuse if plugin subdir already exists
  const pluginDir = join(opts.workspaceDir, 'plugins', pluginId)
  try {
    await readFile(join(pluginDir, 'package.json'), 'utf-8')
    throw new InitError('plugin already exists: plugins/' + pluginId + '/package.json (use a different name)')
  } catch (err) {
    if (err instanceof InitError) throw err
    // ENOENT = good, doesn't exist yet
  }

  await mkdir(pluginDir, { recursive: true })

  const pluginFiles = [
    'package.json',
    'tsconfig.json',
    'manifest.json',
    'host.ts',
    'browser.tsx',
  ]
  const written: string[] = []
  for (const f of pluginFiles) {
    const src = await readFile(join(templateDir, 'plugins', '{{pluginId}}', f), 'utf-8')
    const dst = join(pluginDir, f)
    const rendered = renderTemplate(src, vars)
    await writeFile(dst, rendered, 'utf-8')
    written.push('plugins/' + pluginId + '/' + f)
  }

  // Append to koishi.config.yml (create if absent)
  const configPath = join(opts.workspaceDir, 'koishi.config.yml')
  let configContent = ''
  try {
    configContent = await readFile(configPath, 'utf-8')
  } catch {
    configContent = 'plugins:\n'
  }
  // Check if plugin already listed
  if (!configContent.includes(`id: ${pluginId}`)) {
    if (!configContent.trimEnd().endsWith('\n')) configContent += '\n'
    configContent += `  - id: ${pluginId}\n    path: ./plugins/${pluginId}\n`
    await writeFile(configPath, configContent, 'utf-8')
    written.push('koishi.config.yml (updated)')
  }

  return { dir: pluginDir, files: written }
}
