#!/usr/bin/env node
/**
 * Pre-publish sanity check.
 *
 * Walks every package.json under apps/* and packages/** that has
 * `publishConfig.access === "public"`, computes the family version from
 * apps/cli/package.json, then verifies every internal dep (@flowot/* + nx-pn)
 * at that family version is either:
 *   (a) in this run's publish list (will be published moments from now), or
 *   (b) already resolvable on the npm registry.
 *
 * Exits 0 (closure OK) or 1 (closure broken, missing list printed to stderr
 * with GH Actions `::error::` annotations).
 *
 * Invoked from .github/workflows/npm-publish.yml between
 * "Verify uniform family version" and "Check if tag exists".
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = process.cwd()
const SCAN_TOPS = ['apps', 'packages']
const SCOPE = '@flowot/'
const ALIAS = 'nx-pn'
const MAX_DEPTH = 3

function walk(dir, depth = 0) {
  if (depth > MAX_DEPTH) return []
  if (!existsSync(dir)) return []
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // skip non-workspace / build-output dirs
    if (e.name === 'node_modules' || e.name === '.release' || e.name === 'plugins' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, depth + 1))
    else if (e.name === 'package.json') out.push(p)
  }
  return out
}

// 1. Discover public packages (will be published in this run)
const pkgs = []
for (const top of SCAN_TOPS) {
  for (const pkgPath of walk(join(ROOT, top))) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.publishConfig?.access === 'public') {
      pkgs.push({
        dir: relative(ROOT, pkgPath).replace(/[/\\]package\.json$/, '').replaceAll('\\', '/'),
        name: pkg.name,
        version: pkg.version,
        deps: pkg.dependencies || {},
      })
    }
  }
}

if (pkgs.length === 0) {
  console.error('::error::no public packages found — workspace structure may have changed')
  process.exit(1)
}

// 2. Family version = apps/cli/package.json.version (the canonical source)
const familyVersion = JSON.parse(
    readFileSync(join(ROOT, 'apps/cli/package.json'), 'utf8')
).version

// 3. Build the set of name@version that WILL be on registry after this run
const publishSet = new Set(pkgs.map(p => `${p.name}@${p.version}`))

// 4. For each public package, verify each internal dep at family version
const missing = []
for (const pkg of pkgs) {
  for (const [depName] of Object.entries(pkg.deps)) {
    if (!(depName.startsWith(SCOPE) || depName === ALIAS)) continue
    // workspace:^ resolves to the family version (family is uniform)
    const target = `${depName}@${familyVersion}`
    if (publishSet.has(target)) continue // will be published in this run
    try {
      execSync(`npm view "${target}" version`, { stdio: 'pipe' })
    } catch {
      missing.push({ dep: target, neededBy: pkg.dir })
    }
  }
}

if (missing.length === 0) {
  console.log(
    `✅ family closure OK (${pkgs.length} public packages at v${familyVersion}, all internal deps resolvable)`
  )
  process.exit(0)
}

console.error('❌ dependency closure broken')
console.error('these internal deps are not on registry and not in this publish list:')
for (const m of missing) {
  console.error(`  - ${m.dep}  (needed by ${m.neededBy})`)
  console.error(`::error::${m.dep} not on registry — fix via .github/workflows/npm-fix-publish.yml or include it in this publish run`)
}
process.exit(1)