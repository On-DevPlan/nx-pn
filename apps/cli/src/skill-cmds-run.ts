/**
 * CLI runners for `nx-pn skill install|list|uninstall` — thin console
 * wrappers over the pure skill-cmds.ts functions. Output formatting mirrors
 * plugin-cmds.ts: human by default, --format json for automation.
 */

import type { CliOptions } from './main.js'
import { SkillError, installSkill, listAvailableSkills, uninstallSkill } from './skill-cmds.js'

export async function runSkillInstall(opts: CliOptions): Promise<void> {
  const dst = await installSkill({ name: opts.skillName ?? 'api-audit', force: opts.force ?? false })
  console.log(`✔ 已安装 skill ${opts.skillName ?? 'api-audit'} → ${dst}`)
  console.log(`  (重启 Claude Code 会话后生效)`)
}

export async function runSkillList(opts: CliOptions): Promise<void> {
  const skills = await listAvailableSkills()
  if (opts.format === 'json') {
    console.log(JSON.stringify({ ok: true, count: skills.length, skills }, null, 2))
    return
  }
  if (skills.length === 0) {
    console.log('(无可用 skill)')
    return
  }
  console.log(`可用 skill (安装目标 ~/.claude/skills/):`)
  for (const s of skills) {
    console.log(`  ${s.installed ? '✔' : ' '} ${s.name}${s.installed ? '  (已安装)' : ''}`)
  }
}

export async function runSkillUninstall(opts: CliOptions): Promise<void> {
  if (!opts.skillName) throw new SkillError('skill uninstall requires a skill name')
  const dst = await uninstallSkill({ name: opts.skillName })
  console.log(`✔ 已卸载 skill ${opts.skillName} (removed ${dst})`)
}
