/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillError, listAvailableSkills, listInstalledSkills, installSkill, uninstallSkill } from './skill-cmds.js'

let homeBackup: string | undefined
let fakeHome: string

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), 'nx-pn-skill-home-'))
  homeBackup = process.env.HOME
  process.env.HOME = fakeHome
})

afterEach(async () => {
  if (homeBackup !== undefined) process.env.HOME = homeBackup
  await rm(fakeHome, { recursive: true, force: true })
})

describe('listAvailableSkills', () => {
  it('includes the built-in api-audit skill with its SKILL.md', async () => {
    const skills = await listAvailableSkills()
    expect(skills.length).toBeGreaterThanOrEqual(1)
    const apiAudit = skills.find((s) => s.name === 'api-audit')
    expect(apiAudit).toBeDefined()
    await expect(stat(join(apiAudit!.dir, 'SKILL.md'))).resolves.toBeTruthy()
  })
})

describe('installSkill', () => {
  it('installs api-audit into <HOME>/.claude/skills/api-audit with SKILL.md present', async () => {
    const dst = await installSkill({ name: 'api-audit', homeDir: fakeHome })
    expect(dst).toBe(join(fakeHome, '.claude', 'skills', 'api-audit'))
    const entries = await readdir(dst)
    expect(entries).toContain('SKILL.md')
  })

  it('defaults to api-audit when name is omitted', async () => {
    const dst = await installSkill({ homeDir: fakeHome })
    expect(dst).toBe(join(fakeHome, '.claude', 'skills', 'api-audit'))
  })

  it('refuses to overwrite an existing install without force', async () => {
    await installSkill({ name: 'api-audit', homeDir: fakeHome })
    await expect(installSkill({ name: 'api-audit', homeDir: fakeHome })).rejects.toThrow(SkillError)
    await expect(installSkill({ name: 'api-audit', homeDir: fakeHome, force: true })).resolves.toBeTruthy()
  })

  it('overwrites cleanly with force (no stale files from the old install)', async () => {
    await installSkill({ name: 'api-audit', homeDir: fakeHome })
    // Simulate a stale file a previous version shipped.
    await writeFile(join(fakeHome, '.claude', 'skills', 'api-audit', 'STALE.md'), 'old', 'utf-8')
    await installSkill({ name: 'api-audit', homeDir: fakeHome, force: true })
    const entries = await readdir(join(fakeHome, '.claude', 'skills', 'api-audit'))
    expect(entries).not.toContain('STALE.md')
    expect(entries).toContain('SKILL.md')
  })

  it('throws SkillError for an unknown skill name', async () => {
    await expect(installSkill({ name: 'no-such-skill', homeDir: fakeHome })).rejects.toThrow(/unknown skill/i)
  })
})

describe('listInstalledSkills', () => {
  it('marks api-audit installed after installSkill, absent before', async () => {
    const before = await listInstalledSkills({ homeDir: fakeHome })
    expect(before.some((s) => s.name === 'api-audit')).toBe(false)
    await installSkill({ name: 'api-audit', homeDir: fakeHome })
    const after = await listInstalledSkills({ homeDir: fakeHome })
    expect(after.some((s) => s.name === 'api-audit')).toBe(true)
  })
})

describe('uninstallSkill', () => {
  it('removes the installed skill directory', async () => {
    await installSkill({ name: 'api-audit', homeDir: fakeHome })
    await uninstallSkill({ name: 'api-audit', homeDir: fakeHome })
    await expect(stat(join(fakeHome, '.claude', 'skills', 'api-audit'))).rejects.toThrow()
  })

  it('throws SkillError when the skill is not installed', async () => {
    await expect(uninstallSkill({ name: 'api-audit', homeDir: fakeHome })).rejects.toThrow(/not installed/i)
  })

  it('leaves sibling skill directories untouched', async () => {
    await installSkill({ name: 'api-audit', homeDir: fakeHome })
    const sibling = join(fakeHome, '.claude', 'skills', 'user-own-skill')
    await mkdir(sibling, { recursive: true })
    await writeFile(join(sibling, 'SKILL.md'), 'user content', 'utf-8')
    await uninstallSkill({ name: 'api-audit', homeDir: fakeHome })
    expect(await readFile(join(sibling, 'SKILL.md'), 'utf-8')).toBe('user content')
  })
})
