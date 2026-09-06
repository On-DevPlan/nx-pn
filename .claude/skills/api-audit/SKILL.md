---
name: api-audit
description: Use when working inside the api-audit monorepo — building, testing, debugging, adding features, or writing new plugins. Triggers on questions about the project's architecture, the cordis plugin runtime, host/client/web/cli layout, or the unified audit/replay client.
---

# api-audit

An npx-plugin plugin platform (nx-pn = npx-plugin). Plugins ship a UI page + API; all
network IO goes through core's unified `auditClient`; core provides the audit-occurrence
+ replay hooks. Pages default to a flat view inside the shell sidebar; a plugin can also
claim the whole viewport (`layout: 'fullscreen'`) and manage its own sub-routes.

## Monorepo layout

| Path | Role |
|---|---|
| `apps/cli` | `npx @flowot/nx-pn` entry — start web, `init`/`add`/`uninstall` subcommands |
| `apps/web` | Vite + React shell — sidebar, Audit/Replay/Plugins pages, plugin page host |
| `packages/core` | Zero-cordis pure contracts (Manifest, AuditClient, Middleware) |
| `packages/host` | Node runtime — HTTP, WS RPC, cordis services, plugin loader/installer |
| `packages/client` | Browser runtime — WS RPC, Pages service, auditClient proxy, browser-half loader |
| `plugins/` | Plugin sources — published-plugin form (each lives at `plugins/<id>/` and is built/uploaded to a host) |

## Core invariant

`packages/core` is **zero-cordis pure contracts**. Every package may import from core;
core imports nothing else. This keeps the contract consumable by both Node and browser
without dragging cordis or any other runtime dep across the boundary.

## Quick start

```bash
pnpm install
pnpm -r build
npx @flowot/nx-pn                  # starts web on :4560
npx @flowot/nx-pn init my-plugin   # scaffold a new workspace (9 files: 4 at root + 5 under plugins/<id>/)
npx @flowot/nx-pn init-plugin <id>  # add a plugin to an existing workspace's plugins/ dir
```

### Dev loop (the important UX)

The dev cycle is **workspace-based**: a workspace holds the base in `devDependencies`
and the plugins in `plugins/`. From a plugin dir:

```bash
cd plugins/my-plugin
npm run dev                # dev.mjs spawns the embedded base from ./node_modules/@flowot/nx-pn/bin/nx-pn.mjs, loads this plugin, watches for changes (HMR via zip upload + runId dedup)
```

Or for the monorepo root (`scripts/dev.mjs`):

```bash
node scripts/dev.mjs         # standalone: own host, all plugins
node scripts/dev.mjs --shared  # join the shared host on :4560 (or create one)
cd plugins/X && npm run dev -- --shared  # join a shared host from a plugin dir
```

## How to read this skill

References are split by **who you are** — pick the role that matches your task.

### You're extending the base system (core/host/client/web/cli)

Working inside the api-audit monorepo — adding a service, route, page, manifest field,
debugging dirty state, or understanding how the platform hangs together.

- `references/core-developer/architecture.md` — monorepo walkthrough: how the 5 packages
  fit together, the core invariant, where the cordis runtime lives, what the WS protocol
  actually carries.
- `references/core-developer/extending.md` — how to add a new package / service / route /
  WS op / page / manifest field. The "where do I cut into this thing" entry point.
- `references/core-developer/fullscreen-and-routing.md` — fullscreen plugin mount + nested
  `<Routes>` internals, the splat match, common plugin-side pitfalls.
- `references/core-developer/operations.md` — runtime tuning knobs (ring buffer, poll
  interval), the audit-redaction policy, "nothing works after I played with the host"
  recovery, why plugin runIds churn, end-to-end smoke procedure.

### You're building a third-party plugin

Just want a UI page (or fullscreen dashboard) that uses `ctx.auditClient` / `ctx.hostCall`?
You don't need to read anything in `core-developer/` — start here.

- `references/plugin-developer/plugin-contract.md` — the whole plugin author surface in one
  place: manifest fields, host half shape, browser half shape, the three ctx services
  (`pages` / `auditClient` / `hostCall`), attribution rules, replay.
- `references/plugin-developer/scaffolding.md` — `npx @flowot/nx-pn init my-plugin` produces
  9 files. Walk through each.
- `references/plugin-developer/cli-automation.md` — the CLI as an automation surface: build /
  install / plugin management / audit-trail queries (`--format jsonl|csv`) from the terminal or
  an agent — no browser required. Read this if you want to script your plugin's dev loop.
- `references/plugin-developer/walkthrough-echo.md` — second plugin end-to-end (the
  user-driven request tester). Read this if you want a complete real example with both
  halves and audit attribution.
- `references/plugin-developer/using-the-app.md` — running the app, the three core pages,
  the trust model, troubleshooting.
- `references/plugin-developer/complex-plugins.md` — building a multi-view plugin with an
  external backend: fullscreen + plugin-owned routing, host-half API gateway, BIGINT ids,
  cross-view auth, and a field guide to the failure modes that only show up at scale (double
  Router, post-parse BigInt repair, `navigate()` in render). Read this when your plugin is
  bigger than a counter page, or when you're porting a real admin console.

## Quick decision

| You want to… | Read this first |
|---|---|
| Add a feature to the platform itself | `core-developer/architecture.md` → `extending.md` |
| Debug a problem with the host / web / plugin-sync | `core-developer/operations.md` |
| Build a brand-new plugin (the common case) | `plugin-developer/plugin-contract.md` → `scaffolding.md` |
| Port a real admin app to a multi-view plugin | `plugin-developer/complex-plugins.md` |
| Script / automate your plugin's dev loop (no browser) | `plugin-developer/cli-automation.md` |
| See a complete plugin with audit + replay | `plugin-developer/walkthrough-echo.md` |
