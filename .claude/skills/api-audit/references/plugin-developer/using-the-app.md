# Using api-audit — end-user guide

## What is api-audit?

api-audit is a local API audit workbench that runs as an npx-installable CLI. You launch
a web app that captures every HTTP request made through its unified `auditClient`, lets
you inspect request/response pairs, replay them (with edits), and extend the system with
plugins that ship their own pages and APIs. Every network call is attributed to the
plugin that initiated it.

## Quick start

```bash
pnpm install            # one-time
pnpm -r build           # build all packages
npx @flowot/nx-pn           # starts web on :4560, opens browser
```

Then open `http://localhost:4560` in your browser.

## CLI flags

| Flag | Default | Effect |
|---|---|---|
| `--port <n>` | 4560 | HTTP/WS port (0 = ephemeral) |
| `--data-dir <dir>` | `~/.api-audit` | Where plugins, cache, and audit logs persist |
| `--no-open` | (opens browser) | Don't auto-open the browser |
| `-h`, `--help` | — | Show usage |

## CLI subcommands

```bash
npx @flowot/nx-pn                           # start web server
npx @flowot/nx-pn init <name>               # scaffold a new plugin (8 files, v0.2.0)
npx @flowot/nx-pn add <package-spec>        # install plugin by npm name
npx @flowot/nx-pn uninstall <id|runId>     # remove a plugin
```

**Install formats for `add`:**
- `@scope/name` — npm registry name
- `name@version` — pinned version
- `file:./folder` — local path
- `name` — latest from registry

Re-installing / re-uploading a plugin with an existing `manifest.id` (same name
on npm, or rebuilding the same id) automatically replaces the old run — the
previous fiber is disposed, the browser-half is retracted on connected web
shells, and the new run is the only one in the list. The response carries
`replaced: [<old runId>]`.

## Web UI walkthrough

### `/audit` — audit records

Columns: **time / initiator / method / URL / status / duration**. Click a row for full
detail (request + response headers, body, JSON view when applicable). Every record
carries the `initiator` — the plugin id (or `core` for built-in calls, or
`replay:<id>` for replayed calls).

### `/replay` — API replay

Pick a record from the dropdown, edit the request (method / URL / headers / body),
confirm, and re-run. The new call goes through the same unified `auditClient` and
appears in the audit log with `replayOf: <originalRecordId>`. The page shows the
original and replayed responses side-by-side. Non-idempotent methods (POST/PUT/PATCH/
DELETE) require an explicit confirm step before re-running.

### `/plugins` — plugin management

Two install paths:
1. **By name** — type an npm spec in the text input, click 安装
2. **By zip** — upload a dual-half zip built with `scripts/build-zip.mjs`

The table shows installed plugins with **id / version / status / pluginRunId** and
stop/remove controls. Re-uploading the same id replaces the previous run (the old
fiber is disposed, browser pages are retracted, the registry keeps exactly one
entry per `manifest.id`); the new install gets a fresh `pluginRunId` and the REST
response carries `replaced: [<old runId>]`.

### Plugin pages in the sidebar

When a plugin's browser half registers pages, they appear under the **插件页面**
section in the sidebar. Click → the route hits → the plugin's own React component
renders (using the shared React instance via the import map — spec §5.2.2).

## Where audit records live

- **In-memory ring buffer** (1000 entries) — the live feed
- **JSONL append** to `data-dir/audit/` — persistent history (if the dir exists)

## Trust model

Plugins are bash-trust — they can do anything the host process can. A plugin calling
native `fetch` directly will bypass attribution. The audit attribution only applies to
calls made through the unified `auditClient` proxy. This is a documented boundary
(spec §10), not a bug.

## Replay semantics

A replayed call produces a new `AuditRecord` with:
- `replayOf: <originalRecordId>` — the record it's a replay of
- `initiator: "replay:<recordId>"` — attributed to the replay action
- Same request shape (unless edited in the replay form)
- New status/duration/body reflecting the actual response

## Data directory structure

```
~/.api-audit/
├── plugins-registry/       # npm-installed plugins + installed.json ledger
├── cache/compiled/         # esbuild output for host halves
├── audit/                  # JSONL append of audit records
└── plugins/                # uploaded zips (dual-half path)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Page 404 on `/echo` | Plugin browser half not loaded | Check host log; `GET /api/plugins/:runId/browser-source` should return ESM |
| "Invalid hook call" | React duplicate instance | `pnpm --filter @flowot/nx-pn-web build` (rebuild vendor + vite) |
| WebSocket disconnected | Browser runtime auto-reconnects | Records arrive on reconnect via snapshot reconcile — wait |
| Port 4560 in use | Another instance running | `npx @flowot/nx-pn --port <other>` or kill the existing node process |
| Plugin upload rejected | Manifest schema violation | Check `manifest.json` against `packages/core/src/schema/manifest.schema.json` |
| No audit records | Call bypassed `auditClient` | Plugin must use `ctx.auditClient.*` not native `fetch` |
