# api-audit

A local API audit workbench built as a **cordis plugin platform**. A
Node-side host serves the web UI, runs a cordis `Context`, and exposes a
unified `AuditClient` — every HTTP request made through it (by core, by
replay, or by uploaded plugins) is recorded, credential-redacted, and
attributable. Plugins ship as **dual-half zip packages** (Node half +
browser half) and are hot-added at runtime: upload a zip, and its code
runs without restarting the host.

Design spec: [`docs/superpowers/specs/2026-09-03-api-audit-design.md`](docs/superpowers/specs/2026-09-03-api-audit-design.md)
· Architecture overview: [`docs/architecture.md`](docs/architecture.md)

## Quickstart

```bash
pnpm install
pnpm build          # nx: core → host/client → web → cli (types + libs + web dist)
npx api-audit       # → api-audit listening on http://localhost:4560
```

The CLI opens a browser at `http://localhost:4560`. Flags: `--port <n>`,
`--data-dir <dir>` (default `~/.api-audit`), `--no-open`, `--help`.
`Ctrl-C` shuts down cleanly (plugin fibers dispose first).

> `apps/web` is served by the host from its built `dist/`; without a web
> build the host answers `503 frontend/not-built` on `/`.

## What the pages do

- **`/audit` 审计记录** — live table of every audited request (method,
  URL, status, latency, redacted headers/bodies), pushed over WebSocket.
  Details drawer shows the full record.
- **`/replay` API 重放** — pick a record, optionally edit
  method/URL/headers/body, and re-issue it. The replay runs through the
  same middleware chain and is recorded with `initiator =
  replay:<recordId>` (and `replayOf` linking back). Non-idempotent
  replays ask for confirmation.
- **`/plugins` 插件管理** — upload a plugin zip, list running plugins
  (manifest, run id), stop / remove them.

## Plugins

A plugin is a zip containing:

```
my-plugin.zip
├── manifest.json    # { schemaVersion: 1, id, version, title, halves }
├── host.js          # optional — Node ESM, default-export (ctx) => { … }
└── browser.js       # optional — browser ESM, default-export (ctx) => { … }
```

Upload it on `/plugins` (or `POST /api/plugins`, multipart field `zip`).
The host validates the manifest, esbuild-compiles the host half, imports
it, and runs it as a cordis plugin (`ctx.plugin(half, { name: id })`).
Each load gets a fresh monotonic `pluginRunId`; stopping a plugin
disposes its fiber (event listeners, registered pages — everything
attached to the fiber's effect chain — is cleaned up automatically).

**Attribution:** inside a plugin's host half, `ctx.auditClient.get(...)`
(and post/put/patch/delete) routes through the core `AuditClient`
middleware chain, and the audit middleware records `initiator =
<manifest id>` — plugin IO is audited and attributed by default.
Raw `fetch` bypasses the audit trail entirely (no hard sandbox —
"treat a plugin like bash access to your dev box").

**Demo plugin:** [`plugins/example-api`](plugins/example-api) — a real
dual-half plugin:

```bash
pnpm --filter example-api build   # → plugins/example-api/dist/example-api.zip
```

Its host half registers a tool endpoint (cordis event
`example-api/fetch`) and calls the audit client; its browser half
registers a `/example-api` page through the Pages service. Uploading the
built zip on `/plugins` immediately produces an audit record attributed
to `example-api`.

## Repository layout

```
apps/
  cli/                 # npx api-audit entry (bin, parseArgs, signal handling)
  web/                 # React 18 + Vite shell; core pages /audit /replay /plugins
packages/
  core/                # pure contracts: AuditClient, middleware, manifest schema
  host/                # Node runtime: cordis ctx, HTTP+WS, audit pipeline, plugin loader
  client/              # browser runtime: WS RPC, Pages service, client proxy
plugins/
  example-api/         # demo dual-half zip plugin (built artifact: dist/*.zip)
docs/
  superpowers/specs/   # design spec
```

## Development

```bash
pnpm build   # all packages (nx, dependency-ordered)
pnpm test    # vitest suites: core + host + client + cli
pnpm lint    # per-package tsc --noEmit
bash tools/check-spec.sh   # spec compliance greps (§9.4)
```

The plugin hot-add loop is proven end-to-end by
`packages/host/src/__tests__/hot-add.e2e.test.ts`: it compiles the real
example-api source, uploads the zip over REST, asserts an audit record
attributed to `example-api`, verifies the browser half's
`pages.register` contract, then stops and re-uploads the plugin.
