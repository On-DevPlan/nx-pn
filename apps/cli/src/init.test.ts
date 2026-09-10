/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InitError,
  NAME_PATTERN,
  nameToComponent,
  nameToPath,
  nameToTitle,
  renderTemplate,
  scaffoldPlugin,
  scaffoldPluginInWorkspace,
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
    'writes the workspace structure (12 files) into a fresh dir and replaces {{vars}}',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
      try {
        const result = await scaffoldPlugin({ name: 'demo-plugin', dir, force: false })
        // workspace template: 5 root files (package.json, tsconfig.json,
        // scripts/dev.mjs, scripts/shared-dev.mjs, scripts/build.mjs) +
        // 6 plugin subdir files (incl. host.test.ts) + the .claude/ dev skill = 12
        expect(result.files).toHaveLength(12)
        expect(result.files).toContain('.claude/')

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
        // default layout = 'shell' → browser-sidebar.tsx
        const browser = await readFile(join(dir, 'plugins', 'demo-plugin', 'browser-sidebar.tsx'), 'utf-8')
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
      expect(result.files).toHaveLength(12)
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

  it('writes browser-fullscreen.tsx when layout=fullscreen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
    try {
      await scaffoldPlugin({ name: 'demo-plugin', dir, force: false, layout: 'fullscreen' })
      // fullscreen layout → browser-fullscreen.tsx, NOT browser-sidebar.tsx
      await stat(join(dir, 'plugins', 'demo-plugin', 'browser-fullscreen.tsx'))
      await expect(
        stat(join(dir, 'plugins', 'demo-plugin', 'browser-sidebar.tsx')),
      ).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('default layout is shell (writes browser-sidebar.tsx)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
    try {
      await scaffoldPlugin({ name: 'demo-plugin', dir, force: false, layout: 'shell' })
      await stat(join(dir, 'plugins', 'demo-plugin', 'browser-sidebar.tsx'))
      await expect(
        stat(join(dir, 'plugins', 'demo-plugin', 'browser-fullscreen.tsx')),
      ).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('scaffoldPluginInWorkspace (init-plugin)', () => {
  /** Fresh workspace via `init`, as the real flow does. */
  async function makeWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'init-ws-'))
    await scaffoldPlugin({ name: 'first-plugin', dir, force: false })
    return dir
  }

  it('adds a second plugin with browser-sidebar.tsx + host.test.ts (default shell)', async () => {
    const ws = await makeWorkspace()
    try {
      await scaffoldPluginInWorkspace({ name: 'second-plugin', workspaceDir: ws, layout: 'shell' })
      await stat(join(ws, 'plugins', 'second-plugin', 'browser-sidebar.tsx'))
      await stat(join(ws, 'plugins', 'second-plugin', 'host.test.ts'))
      await expect(
        stat(join(ws, 'plugins', 'second-plugin', 'browser-fullscreen.tsx')),
      ).rejects.toThrow()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('layout=fullscreen writes browser-fullscreen.tsx instead', async () => {
    const ws = await makeWorkspace()
    try {
      await scaffoldPluginInWorkspace({ name: 'second-plugin', workspaceDir: ws, layout: 'fullscreen' })
      await stat(join(ws, 'plugins', 'second-plugin', 'browser-fullscreen.tsx'))
      await expect(
        stat(join(ws, 'plugins', 'second-plugin', 'browser-sidebar.tsx')),
      ).rejects.toThrow()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('appends the plugin entry to koishi.config.yml', async () => {
    const ws = await makeWorkspace()
    try {
      await scaffoldPluginInWorkspace({ name: 'second-plugin', workspaceDir: ws, layout: 'shell' })
      const cfg = await readFile(join(ws, 'koishi.config.yml'), 'utf-8')
      expect(cfg).toContain('id: second-plugin')
      expect(cfg).toContain('path: ./plugins/second-plugin')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('refuses when the plugin already exists', async () => {
    const ws = await makeWorkspace()
    try {
      await expect(
        scaffoldPluginInWorkspace({ name: 'first-plugin', workspaceDir: ws, layout: 'shell' }),
      ).rejects.toThrow(InitError)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('refuses when the directory has no package.json (not a workspace)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'init-ws-'))
    try {
      await expect(
        scaffoldPluginInWorkspace({ name: 'some-plugin', workspaceDir: dir, layout: 'shell' }),
      ).rejects.toThrow(/no package\.json/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('template ↔ fileList lockstep (anti-desync)', () => {
  const templateDir = fileURLToPath(new URL('../templates/plugin-workspace', import.meta.url))

  /** Recursively collect relative file paths under dir. */
  async function walk(dir: string, base = ''): Promise<string[]> {
    const out: string[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)))
      else out.push(rel)
    }
    return out
  }

  it('init scaffolds every template file (root + plugin, minus the unselected browser layout)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
    try {
      const result = await scaffoldPlugin({ name: 'demo-plugin', dir, force: false })
      const written = new Set(result.files)

      // Root scope: every non-plugin, non-.claude template file must be reported
      // (catches a file added to templates/ but forgotten in rootFiles).
      for (const rel of await walk(templateDir)) {
        if (rel.startsWith('.claude/')) continue // copied via copyDir, reported once as '.claude/'
        if (rel.startsWith('plugins/')) continue // plugin scope checked below
        expect(written.has(rel), `template root file missing from init output: ${rel}`).toBe(true)
      }

      // Plugin scope: everything except the browser variant NOT selected by
      // layout=shell (catches stale names like the removed browser.tsx).
      const excluded = new Set(['browser-fullscreen.tsx'])
      for (const f of await walk(join(templateDir, 'plugins', '{{pluginId}}'))) {
        if (excluded.has(f)) continue
        expect(written.has(`plugins/demo-plugin/${f}`), `template plugin file missing: ${f}`).toBe(true)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('init-plugin scaffolds every template plugin file, for both layouts', async () => {
    for (const layout of ['shell', 'fullscreen'] as const) {
      const ws = await mkdtemp(join(tmpdir(), 'init-ws-'))
      try {
        await scaffoldPlugin({ name: 'first-plugin', dir: ws, force: false })
        await scaffoldPluginInWorkspace({ name: 'second-plugin', workspaceDir: ws, layout })
        const excluded = layout === 'shell' ? 'browser-fullscreen.tsx' : 'browser-sidebar.tsx'
        for (const f of await walk(join(templateDir, 'plugins', '{{pluginId}}'))) {
          const out = join(ws, 'plugins', 'second-plugin', f)
          if (f === excluded) {
            await expect(stat(out), `${layout}: ${f} must not be scaffolded`).rejects.toThrow()
          } else {
            await stat(out) // ENOENT here = a fileList entry went stale
          }
        }
      } finally {
        await rm(ws, { recursive: true, force: true })
      }
    }
  })

  it('template scripts stay resolvable: every npm script target file exists after scaffold', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
    try {
      await scaffoldPlugin({ name: 'demo-plugin', dir, force: false })
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'))
      // test script references plugins/<id>/host.test.ts — must exist
      const testTarget = pkg.scripts.test.match(/--test\s+(\S+)/)![1]!
      await stat(join(dir, testTarget))
      // typecheck references plugins/<id>/tsconfig.json — must exist
      const tscTarget = pkg.scripts.typecheck.match(/-p\s+(\S+)/)![1]!
      await stat(join(dir, tscTarget))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('no template file references the removed literal browser.tsx', async () => {
    // Regression guard for 0.4.3: browser.tsx was renamed to browser-sidebar.tsx /
    // browser-fullscreen.tsx, but build.mjs / tsconfig were left pointing at the old
    // name. Any occurrence of the bare token means a script will ENOENT at run time.
    for (const rel of await walk(templateDir)) {
      const body = await readFile(join(templateDir, rel), 'utf-8')
      expect(body.includes('browser.tsx'), `stale reference to browser.tsx in ${rel}`).toBe(false)
    }
  })

  it('installs the .claude/ dev skill by default (template ships it nested)', async () => {
    // Regression guard: the probe used to read .claude/SKILL.md (flat) while the
    // template ships .claude/skills/<name>/SKILL.md — the skill was silently
    // skipped for every scaffold. Assert it lands in the output.
    const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
    try {
      const result = await scaffoldPlugin({ name: 'demo-plugin', dir, force: false })
      expect(result.files).toContain('.claude/')
      await stat(join(dir, '.claude', 'skills', 'api-audit', 'SKILL.md'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('omits .claude/ when skill:false (--no-skill)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'init-test-'))
    try {
      const result = await scaffoldPlugin({ name: 'demo-plugin', dir, force: false, skill: false })
      expect(result.files).not.toContain('.claude/')
      await expect(stat(join(dir, '.claude'))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})