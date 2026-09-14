/**
 * `nx-pn skill install|list|uninstall` — manage the official nx-pn skills
 * in the user's global Claude Code skill directory (~/.claude/skills/).
 *
 * Skills ship inside the CLI package at assets/skills/<name>/SKILL.md —
 * adding a new skill is just dropping a directory there (zero code change).
 * This command family never touches the network or a running host; it is
 * pure filesystem work, unlike `plugin`/`audit` which target a live host.
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export class SkillError extends Error {}

export interface SkillEntry {
  name: string
  dir: string
  installed: boolean
}

/** Locate the packaged assets/skills directory (compiled lib/ or dev src/). */
async function locateAssetsSkillsDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'assets', 'skills'),
    join(process.cwd(), 'apps', 'cli', 'assets', 'skills'),
  ]
  for (const dir of candidates) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      if (entries.some((e) => e.isDirectory())) return dir
    } catch {
      // try next
    }
  }
  throw new SkillError('cannot locate assets/skills (tried: ' + candidates.join(', ') + ')')
}

/** Resolve the user home dir: $HOME first (Windows os.homedir() reads
 * USERPROFILE and ignores HOME, which breaks HOME-override testing and
 * non-standard layouts), falling back to os.homedir(). */
function userHome(): string {
  return process.env.HOME && process.env.HOME.trim() !== '' ? process.env.HOME : homedir()
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Recursively copy a directory tree. */
async function copyDir(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) await copyDir(s, d)
    else await copyFile(s, d)
  }
}

/** One packaged skill's source directory: assets/skills/<name>/ with a SKILL.md. */
async function skillSourceDir(name: string): Promise<string> {
  const dir = join(await locateAssetsSkillsDir(), name)
  if (!(await pathExists(join(dir, 'SKILL.md')))) {
    throw new SkillError(`unknown skill: ${name} (run "nx-pn skill list" for available skills)`)
  }
  return dir
}

/** All skills packaged in the CLI, each flagged installed-in-home. */
export async function listAvailableSkills(homeDir?: string): Promise<SkillEntry[]> {
  const home = homeDir ?? userHome()
  const assetsDir = await locateAssetsSkillsDir()
  const entries: SkillEntry[] = []
  for (const entry of await readdir(assetsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!(await pathExists(join(assetsDir, entry.name, 'SKILL.md')))) continue
    entries.push({
      name: entry.name,
      dir: join(assetsDir, entry.name),
      installed: await pathExists(join(home, '.claude', 'skills', entry.name, 'SKILL.md')),
    })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/** Installed subset — what a plain "what did nx-pn put here" check reads. */
export async function listInstalledSkills(opts: { homeDir?: string } = {}): Promise<SkillEntry[]> {
  const all = await listAvailableSkills(opts.homeDir)
  return all.filter((s) => s.installed)
}

/**
 * Copy assets/skills/<name>/ → <home>/.claude/skills/<name>/.
 * Refuses an existing install unless force (which replaces cleanly — the
 * old directory is removed first so stale files never survive an upgrade).
 * Omitting name installs the default skill (api-audit).
 */
export async function installSkill(opts: { name?: string; homeDir?: string; force?: boolean }): Promise<string> {
  const name = opts.name ?? 'api-audit'
  const home = opts.homeDir ?? userHome()
  const src = await skillSourceDir(name)
  const dst = join(home, '.claude', 'skills', name)
  if ((await pathExists(dst)) && !opts.force) {
    throw new SkillError(`skill already installed: ${dst} (use --force to replace)`)
  }
  await rm(dst, { recursive: true, force: true })
  await copyDir(src, dst)
  return dst
}

/** Remove <home>/.claude/skills/<name>/ — only that directory, never siblings. */
export async function uninstallSkill(opts: { name: string; homeDir?: string }): Promise<string> {
  const home = opts.homeDir ?? userHome()
  const dst = join(home, '.claude', 'skills', opts.name)
  if (!(await pathExists(dst))) {
    throw new SkillError(`skill not installed: ${dst}`)
  }
  await rm(dst, { recursive: true, force: true })
  return dst
}
