#!/usr/bin/env node
/**
 * api-audit bin — the `npx api-audit` entry (spec §2.2).
 *
 * Thin wrapper: the typed orchestration lives in ../lib/main.js, built
 * by `tsc -b`. A missing build output produces a friendly hint instead
 * of a raw module-not-found stack. (Plain JS on purpose — the bin must
 * run before any build step exists.)
 */

async function boot() {
  let mod
  try {
    mod = await import('../lib/main.js')
  } catch {
    console.error('api-audit: build output missing (lib/main.js).')
    console.error('Run `pnpm install && pnpm build` in the api-audit repo first.')
    process.exit(1)
  }
  try {
    await mod.runCli(process.argv.slice(2))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('api-audit: ' + message)
    process.exit(1)
  }
}

void boot()
