# api-audit

A local API audit workbench built as a **cordis plugin platform**. A
Node-side host serves the web UI, runs a cordis `Context`, and exposes a
unified `AuditClient` — every HTTP request made through it (by core, by
replay, or by plugins) is recorded, credential-redacted, and
attributable. Plugins install by **npm package name** (`npx @flowot/nx-pn
add <pkg>`) — the npx-plugin primary path — with dual-half **zip upload**
kept as a secondary channel. Either way a plugin hot-loads at runtime
without restarting the host.

Design spec: [`docs/superpowers/specs/2026-09-03-api-audit-design.md`](docs/superpowers/specs/2026-09-03-api-audit-design.md)
· Architecture overview: [`docs/architecture.md`](docs/architecture.md)

## Quickstart

```bash
pnpm install
pnpm build          # nx: core → host/client → web → cli (types + libs + web dist)
npx @flowot/nx-pn       # → api-audit listening on http://localhost:4560
npx @flowot/nx-pn add @scope/my-audit-plugin   # install a plugin by npm package name
```

Published to npm as the `@flowot/nx-pn*` family (CLI, core, client, web,
host); the unscoped alias package `nx-pn` forwards to the same bin, so
`npx nx-pn` works too.

The CLI opens a browser at `http://localhost:4560`. Flags: `--port <n>`,
`--data-dir <dir>` (default `~/.api-audit`), `--no-open`, `--help`.
Subcommands: `add <spec>` (install by package name / `file:` path) and
`uninstall <id|runId>`. `Ctrl-C` shuts down cleanly (plugin fibers
dispose first).

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
- **`/plugins` 插件管理** — install a plugin by npm package name, upload a
  plugin zip (secondary), list running plugins (manifest, run id), stop /
  remove / uninstall them.

## Plugins

### 按包名安装（primary, npx-plugin）

A plugin is a plain **npm package**. `package.json` declares the
manifest under `api-audit.manifest` and points `main` (or
`exports["."]`) at an ESM host half:

```json
{
  "name": "@scope/my-audit-plugin",
  "version": "1.2.3",
  "type": "module",
  "main": "./host.js",
  "exports": { ".": "./host.js" },
  "api-audit": {
    "manifest": {
      "id": "my-audit-plugin",
      "version": "1.2.3",
      "title": "My Audit Plugin"
    },
    "browser": "./browser.js"
  }
}
```

`host.js` is ESM and default-exports `(ctx) => { … }` — the same shape a
zip host half had, and it can call `ctx.auditClient`. npm already
delivers compiled JS, so the host just `import()`s it — **no esbuild**.

```js
export default function (ctx) {
  ctx.on('my-plugin/trigger', async ({ url }) => {
    const r = await ctx.auditClient.get(url) // audited + attributed
    return r.status
  })
}
```

Install it into the running host by package name:

```bash
npx @flowot/nx-pn add @scope/my-audit-plugin     # or name@1.2.3 / file:./folder
npx @flowot/nx-pn uninstall my-audit-plugin
```

or from the `/plugins` 按包名安装 form in the web UI. The host installs
the package into `data-dir/plugins-registry`, validates the manifest with
the same core schema as zip uploads, loads the host half, and registers
it — attribution (`initiator = manifest id`) works exactly like the zip
path. Installed specs are recorded in `data-dir/plugins-registry/
installed.json` and replayed on the next host boot.

**Attribution:** inside a plugin's host half, `ctx.auditClient.get(...)`
(and post/put/patch/delete) routes through the core `AuditClient`
middleware chain, and the audit middleware records `initiator =
<manifest id>` — plugin IO is audited and attributed by default.
Raw `fetch` bypasses the audit trail entirely (no hard sandbox —
"treat a plugin like bash access to your dev box").

### 上传 zip（secondary channel）

The original dual-half zip format still works:

```
my-plugin.zip
├── manifest.json    # { schemaVersion: 1, id, version, title, halves }
├── host.js          # optional — Node ESM, default-export (ctx) => { … }
└── browser.js       # optional — browser ESM, default-export (ctx) => { … }
```

Upload it on `/plugins` (or `POST /api/plugins`, multipart field `zip`).
The host validates the manifest, esbuild-compiles the host half, imports
it, and runs it as a cordis plugin (`ctx.plugin(half, { name: id })`).

Every load — by name or by zip — gets a fresh monotonic `pluginRunId`;
stopping a plugin disposes its fiber (event listeners, registered pages —
everything attached to the fiber's effect chain — is cleaned up
automatically).

**Demo plugin:** [`plugins/example-api`](plugins/example-api) — a real
dual-half zip plugin:

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
  cli/                 # npx @flowot/nx-pn entry (bin, parseArgs, signal handling)
  web/                 # React 18 + Vite shell; core pages /audit /replay /plugins
packages/
  core/                # pure contracts: AuditClient, middleware, manifest schema
  host/                # Node runtime: cordis ctx, HTTP+WS, audit pipeline,
                       #   plugin installer (npm install-by-name) + zip loader
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

The plugin loop is proven end-to-end by two host e2e tests:
`packages/host/src/__tests__/hot-add.e2e.test.ts` (zip upload → attributed
record → stop → re-upload) and
`packages/host/src/__tests__/install-by-name.e2e.test.ts` (npm package
install via an offline `file:` spec → attributed record → unload →
re-install → restart from the install ledger).
