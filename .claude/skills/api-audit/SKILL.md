---
name: api-audit
description: Use when working inside the api-audit monorepo — building, testing, debugging, adding features, or writing new plugins. Triggers on questions about the project's architecture, the cordis plugin runtime, host/client/web/cli layout, or the unified audit/replay client.
---

# api-audit

An npx-plugin plugin platform (nx-pn = npx-plugin). Plugins ship a UI page + API; all
network IO goes through core's unified `auditClient`; core provides the audit-occurrence
+ replay hooks.

## Monorepo layout

| Path | Role |
|---|---|
| `apps/cli` | `npx @flowot/nx-pn` entry — start web, `add`/`uninstall` subcommands |
| `apps/web` | Vite + React shell — sidebar, Audit/Replay/Plugins pages, plugin page host |
| `packages/core` | Zero-cordis pure contracts (Manifest, AuditClient, Middleware) |
| `packages/host` | Node runtime — HTTP, WS RPC, cordis services, plugin loader/installer |
| `packages/client` | Browser runtime — WS RPC, Pages service, auditClient proxy, browser-half loader |
| `plugins/` | Plugin sources — each is its own workspace package |

## Core invariant

`packages/core` is **zero-cordis pure contracts**. Every package may import from core;
core imports nothing else. This keeps the contract consumable by both Node and browser
without dragging cordis or any other runtime dep across the boundary.

## Quick start

```bash
pnpm install
pnpm -r build
npx @flowot/nx-pn                  # starts web on :4560
```

## How to read this skill

Each reference file answers one question. SKILL.md orients.

- **How do I USE the running app?** → `references/usage.md`
- **How do I develop within the repo?** → `references/development.md`
- **How do I extend (add packages, services, routes, pages, manifest fields)?** → `references/extension.md`
- **What's the contract for plugin authors?** → `references/plugin-protocol.md`
- **Walkthrough of the second plugin?** → `references/second-plugin.md`
