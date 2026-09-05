/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InitError,
  NAME_PATTERN,
  nameToComponent,
  nameToPath,
  nameToTitle,
  renderTemplate,
  scaffoldPlugin,
  validateName,
} from './init.js'

describe('validateName', () => {
  it.each(['a', 'my-plugin', 'plugin123', 'my-cool-plugin-v2', 'a1b2c3'])('accepts %s', (name) => {
    expect(() => validateName(name)).not.toThrow()
  })

  it.each([
    ['MyPlugin', 'leading uppercase'],
    ['my_plugin', 'underscore'],
    ['我的插件', 'non-ASCII'],
    ['', 'empty'],
    ['a'.repeat(65), 'too long'],
    ['-leading-hyphen', 'leading hyphen'],
    ['trailing-hyphen-', 'trailing hyphen'],
    ['A', 'single uppercase'],
    ['.dot', 'starts with dot'],
  ])('rejects %s (%s)', (name) => {
    expect(() => validateName(name)).toThrow(InitError)
  })
})

describe('NAME_PATTERN', () => {
  it('matches the documented shape', () => {
    expect(NAME_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{0,63}$')
  })
})

describe('nameToTitle', () => {
  it('converts kebab-case to Title Case', () => {
    expect(nameToTitle('my-plugin')).toBe('My Plugin')
    expect(nameToTitle('gh-issues')).toBe('Gh Issues')
    expect(nameToTitle('a')).toBe('A')
    expect(nameToTitle('a-b-c-d')).toBe('A B C D')
  })
})

describe('nameToPath', () => {
  it('prepends /', () => {
    expect(nameToPath('my-plugin')).toBe('/my-plugin')
    expect(nameToPath('a')).toBe('/a')
  })

  it('produces a path that satisfies the manifest page regex', () => {
    const p = nameToPath('my-plugin')
    expect(/^\/[a-zA-Z0-9_\-\/.:]*$/.test(p)).toBe(true)
  })
})

describe('nameToComponent', () => {
  it('converts kebab-case to PascalCase', () => {
    expect(nameToComponent('my-plugin')).toBe('MyPlugin')
    expect(nameToComponent('gh-issues')).toBe('GhIssues')
  })
})

describe('renderTemplate', () => {
  it('replaces {{key}}', () => {
    expect(renderTemplate('hello {{name}}', { name: 'world' })).toBe('hello world')
  })

  it('replaces multiple occurrences', () => {
    expect(renderTemplate('{{a}}-{{a}}', { a: '1' })).toBe('1-1')
  })

  it('leaves text without placeholders alone', () => {
    expect(renderTemplate('plain text', { a: '1' })).toBe('plain text')
  })

  it('throws on missing variable', () => {
    expect(() => renderTemplate('{{x}}', {})).toThrow(/not provided/)
  })

  it('replaces keys with hyphens (e.g. user-agent)', () => {
    // Regression: \w in the regex doesn't include '-', so keys like
    // `user-agent` would silently leak through as the literal text.
    expect(renderTemplate('{{user-agent}}', { 'user-agent': 'api-audit-x/0.1.0' })).toBe(
      'api-audit-x/0.1.0',
    )
  })
})

describe('scaffoldPlugin (end-to-end)', () => {
  it(
    'writes the workspace structure (14 files) into a fresh dir and replaces {{vars}}',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
      try {
        const result = await scaffoldPlugin({ name: 'demo-plugin', dir, force: false })
        // workspace template: 4 root files + 5 plugin subdir files = 9 files
        expect(result.files).toHaveLength(9)

        // manifest.json IS scaffolded (workspace template includes it)
        const manifest = JSON.parse(await readFile(join(dir, 'plugins', 'demo-plugin', 'manifest.json'), 'utf-8'))
        expect(manifest.id).toBe('demo-plugin')
        expect(manifest.halves).toBeDefined()
        expect(manifest.halves.host?.entry).toBeDefined()
        expect(manifest.halves.browser?.entry).toBeDefined()

        const pkg = await readFile(join(dir, 'package.json'), 'utf-8')
        expect(pkg).toContain('"name": "demo-plugin"')
        expect(pkg).toContain('"dev": "node scripts/dev.mjs"')

        const host = await readFile(join(dir, 'plugins', 'demo-plugin', 'host.ts'), 'utf-8')
        expect(host).toContain('demo-plugin')
        const browser = await readFile(join(dir, 'plugins', 'demo-plugin', 'browser.tsx'), 'utf-8')
        expect(browser).toContain('browserHalf') // template function name

        const stat2 = await stat(join(dir, 'scripts', 'dev.mjs'))
        expect(stat2.isFile()).toBe(true)
        const stat3 = await stat(join(dir, 'scripts', 'build.mjs'))
        expect(stat3.isFile()).toBe(true)
        const dev = await readFile(join(dir, 'scripts', 'dev.mjs'), 'utf-8')
        // dev.mjs is a generic script; check it contains the nx-pn binary reference
        expect(dev).toContain('nx-pn.mjs')

        // tsconfig.json at workspace root
        const tsconfig = await readFile(join(dir, 'tsconfig.json'), 'utf-8')
        expect(tsconfig).toContain('@flowot/plugin-*')
        expect(tsconfig).toContain('plugins/*/src')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  it('refuses non-empty dir without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
    try {
      await scaffoldPlugin({ name: 'demo-plugin', dir, force: false })
      await expect(scaffoldPlugin({ name: 'demo-plugin', dir, force: false })).rejects.toThrow(
        InitError,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('overwrites with --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
    try {
      await scaffoldPlugin({ name: 'demo-plugin', dir, force: false })
      const result = await scaffoldPlugin({ name: 'demo-plugin', dir, force: true })
      expect(result.files).toHaveLength(9)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid name before touching disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
    try {
      await expect(scaffoldPlugin({ name: 'BadName', dir, force: false })).rejects.toThrow(
        InitError,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
