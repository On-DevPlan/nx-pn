#!/usr/bin/env node
/**
 * api-audit bin — the `npx @flowot/nx-pn` entry (spec §2.2).
 *
 * Thin wrapper: the typed orchestration lives in ../lib/main.js, built
 * by `tsc -b`. (Plain JS on purpose — the bin must run before any build
 * step exists.)
 *
 * Import failures print the REAL error, then the "build output missing"
 * hint only when the module genuinely isn't there. A bare catch here once
 * swallowed an ERR_MODULE_NOT_FOUND for a runtime dependency and reported
 * it as a missing build — costing a whole debug cycle.
 */

async function boot() {
  let mod
  try {
    mod = await import('../lib/main.js')
  } catch (err) {
    const code = err?.code
    if (code === 'ERR_MODULE_NOT_FOUND' && String(err?.message).includes('lib/main.js')) {
      console.error('api-audit: build output missing (lib/main.js).')
      console.error('Run `pnpm install && pnpm build` in the api-audit repo first.')
    } else {
      console.error('api-audit: failed to start —')
      console.error(err?.stack || String(err))
      if (code === 'ERR_MODULE_NOT_FOUND') {
        console.error('(a runtime dependency is missing — check the package\'s "dependencies" field)')
      }
    }
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
