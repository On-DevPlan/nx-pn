/**
 * Plugin scaffolder for `npx @flowot/nx-pn init <name>` (spec §).
 * Pure functions: validateName / nameToTitle / nameToPath / nameToComponent /
 * renderTemplate. I/O lives in scaffoldPlugin.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * templates at apps/cli/templates/plugin-basic/. Falls back to cwd-based
 * resolution during development (no lib/ yet).
 */
async function locateTemplateDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'templates', 'plugin-basic'),
    join(process.cwd(), 'apps', 'cli', 'templates', 'plugin-basic'),
  ]
  for (const dir of candidates) {
    try {
      await readFile(join(dir, 'package.json'), 'utf-8')
      return dir
    } catch {
      // try next
    }
  }
  throw new InitError('cannot locate templates/plugin-basic (tried: ' + candidates.join(', ') + ')')
}

export async function scaffoldPlugin(opts: InitOptions): Promise<InitResult> {
  validateName(opts.name)
  const title = nameToTitle(opts.name)
  const path = nameToPath(opts.name)
  const componentName = nameToComponent(opts.name)
  const vars: Record<string, string> = {
    id: opts.name,
    title,
    path,
    pageComponentName: componentName,
    description: 'Scaffolded api-audit plugin: ' + title,
    'user-agent': 'api-audit-' + opts.name + '/0.1.0',
  }

  const templateDir = await locateTemplateDir()
  // manifest.json is NOT scaffolded — the build script generates it from
  // package.json (single source of truth; see scripts/build-zip.mjs).
  const fileList = [
    'package.json',
    'host.ts',
    'browser.tsx',
    'tsconfig.json',
    'README.md',
    '.gitignore',
    'scripts/build-zip.mjs',
    'scripts/dev.mjs',
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
  await mkdir(join(opts.dir, 'scripts'), { recursive: true })

  const written: string[] = []
  for (const f of fileList) {
    const src = await readFile(join(templateDir, f), 'utf-8')
    const dst = join(opts.dir, f)
    const rendered = renderTemplate(src, vars)
    await writeFile(dst, rendered, 'utf-8')
    written.push(f)
  }

  return { dir: opts.dir, files: written }
}
