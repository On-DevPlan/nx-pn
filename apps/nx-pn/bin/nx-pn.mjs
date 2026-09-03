#!/usr/bin/env node
/**
 * `nx-pn` — unscoped alias bin (registers the npm name `nx-pn`).
 *
 * Forwards to the real bin in @flowot/nx-pn. process.argv passes through
 * untouched, so `nx-pn add <pkg>` parses exactly like
 * `npx @flowot/nx-pn add <pkg>`.
 */
await import('@flowot/nx-pn/bin/nx-pn.mjs')
