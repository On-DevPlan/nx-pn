# api-audit — Architecture

Full design spec (authoritative):
[`docs/superpowers/specs/2026-09-03-api-audit-design.md`](superpowers/specs/2026-09-03-api-audit-design.md).
This page is the short map: four packages, one plugin platform.

> **Identity (npx-plugin):** api-audit is `nx-pn` — the plugin system is
> driven by **npm package names**. A user publishes a plugin as an npm
> package, any consumer runs `npx api-audit add <pkg>`, and the plugin is
> installed into `data-dir/` and loaded into the running host. Zip
> dual-half upload remains as the **secondary** channel.

## The four packages

```
┌───────────────────────────  browser  ───────────────────────────┐
│  apps/web (React shell)  ── uses ──▶  packages/client           │
│  /audit /replay /plugins              WS RPC · Pages service    │
│                                       AuditClient proxy         │
└───────────────────────────────┬─────────────────────────────────┘
                                │ REST /api/* + WS /ws (RPC frames)
┌───────────────────────────────▼─────────────────────────────────┐
│  packages/host (Node)                                           │
│  cordis Context · HTTP server · WsHostServer · AuditRingBuffer  │
│  HostAuditClient (undici + onion middleware + credential        │
│  redaction) · plugin installer (npm install-by-name → import →  │
│  fiber) · plugin loader (zip → esbuild → import → fiber)        │
│  ▲ deps                                                          │
│  packages/core — pure contracts shared by both sides            │
└─────────────────────────────────────────────────────────────────┘
```

- **`packages/core`** — zero runtime logic beyond manifest validation
  (ajv). Owns the `AuditClient` interface, `Middleware` onion types,
  `Manifest` schema + `validateManifest`, `redactCredentials`. No
  cordis import, no Context augmentation (enforced by
  `tools/check-spec.sh`).
- **`packages/host`** — boots via `startHost({ port, dataDir })`. Core
  cordis services on the root Context: `auditClient`, `auditStore`,
  `plugins`, `credentials`. Every audited request flows
  `audit-middleware → performFetch`; records land in a 1000-entry ring
  buffer and broadcast to browsers as `audit.append` WS frames.
- **`packages/client`** — browser runtime: WS transport with reconnect
  backoff, RPC client (30s timeout, generation-mismatch rejection),
  Pages service (prototype methods so cordis's caller-tracker scopes
  each registration to the calling plugin's fiber), and a
  `ClientAuditClientProxy` that forwards plugin requests over WS RPC.
- **`apps/web`** — React 18 + react-router shell rendering the three
  core pages; the host serves its `dist/` statically (per-request
  readFile, resolved via `@api-audit/web/package.json`).
- **`apps/cli`** — the `api-audit` bin: `parseArgs` (`--port`,
  `--data-dir`, `--no-open`) + one-shot subcommands `add <spec>` /
  `uninstall <id|runId>` → `startHost` → open browser → SIGINT/SIGTERM
  → clean stop.

## Request lifecycle (audit pipeline)

```
caller (core / replay / plugin via ctx.auditClient)
  → HostAuditClient.get/post/…            # MiddlewareContext built
  → audit middleware (outermost)          # redactCredentials BEFORE fetch
      → performFetch (undici, ≤1 MiB buffered, JSON detected)
  ← AuditResponse
  → AuditRecord pushed to ring buffer     # id, ts, initiator, replayOf…
  → broadcast audit.append over WS        # browsers live-update
```

`initiator` values: `core` (direct), `replay:<recordId>` (replay route),
`<manifest id>` (plugins — resolved from the calling plugin's cordis
fiber against the lifecycle registry, spec §7.4).

## Plugin lifecycle (install-by-name, primary)

```
POST /api/plugins/install { spec }        or `npx api-audit add <spec>`
  → npm install <spec> --prefix data-dir/plugins-registry --no-save …
  → build core Manifest from package.json["api-audit"].manifest + main
  → validateManifest          → 400 on schema violation / missing manifest
  → import(hostEntry)         → no esbuild (npm ships compiled JS)
  → ctx.plugin(halfFn, { name: id }) → register BEFORE await
  → await fiber.await() → lifecycle.register { id, pluginRunId, fiber }
  → record spec in data-dir/plugins-registry/installed.json   → 201
```

The installed spec ledger is replayed on every host boot (`startHost`
calls `restartNpmPlugins` after the zip replay), so npm-installed plugins
reload across restarts — parity with zip persistence.

## Plugin lifecycle (zip upload, secondary)

```
POST /api/plugins (zip)
  → validateManifest            → 400 on schema violation
  → esbuild compile host half   → data-dir/cache/compiled/<id>-<hash>.mjs
  → pathToFileURL → import()
  → ctx.plugin(halfFn, { name: id }) → await fiber.await()
  → lifecycle.register { id, pluginRunId, fiber, manifest }   → 201
  → (browser half: pushed to connected browsers as browser-half.load
     → blob import → ctx.plugin → pages.register — see notes below)

stop:      POST /api/plugins/:runId/stop   → fiber.dispose() (effects run)
remove:    POST /api/plugins/:runId/remove → stop + registry eviction
uninstall: POST /api/plugins/:runId/uninstall → remove + drop npm ledger
restart:   startHost replays data-dir/plugins/*.zip + the install ledger
```

Failure isolation: a plugin that throws during activation has its fiber
disposed and the upload answers 5xx with the message; the host keeps
running. Plugin zips persist in `data-dir/plugins/` and reload on boot.

## Where the seams are (honest scope notes)

- **Browser-half live rendering.** The host loader compiles + loads the
  host half; the browser half is compiled, shipped in the zip, and its
  `ctx.pages.register` contract is proven (hot-add e2e +
  `activateBrowserHalf` tests in packages/client), but the web shell's
  sidebar/routes are still static — dynamic registry-driven rendering
  and the shared-React import map (spec §5.2.2) are the next step.
- **WS RPC auditClient bridge.** The browser proxy speaks the full frame
  protocol; the host-side `rpc.invoke` → `auditClient` dispatcher is not
  wired yet (plugin host halves use `ctx.auditClient` in-process).
- **No hard sandbox.** A plugin using raw `fetch` bypasses auditing by
  design (spec §7.5).
