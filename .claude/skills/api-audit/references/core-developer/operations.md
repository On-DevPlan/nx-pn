# Operations & Field Notes

> **Audience:** the developer who just hit a wall (UI broken, plugin half 404, login button dead,
> CPU spiking, ring buffer eating RAM). The things the planning docs can't warn you about
> because they only show up after you live with the system for a while.

## "Nothing works after I played with the host" — the single most common failure

**Symptom:** the devctr-kv page shows "页面不存在" (404), the plugin sidebar entry flickers in and out,
the "去登录" button does nothing, you see stale `pluginRunId`s, or the audit log fills with the
same call 40+ times in one second.

**Cause:** the data directory `~/.api-audit/` accumulates state across host restarts:
- multiple `pluginRunId`s per plugin id (from re-uploads)
- browser halves loaded against the *current* run, but the *previous* run is still in the
  host's lifecycle registry → when the host restarts, ledger replay re-registers old runs and
  the browser half loader sees a "new" pluginRunId every snapshot push
- example-api's activation hello is fire-and-forget — each re-apply fires another `GET httpbin.org/get`

**Fix (destructive, clean slate):**

```bash
# 1. Stop the host
powershell -Command "Get-NetTCPConnection -LocalPort 4560 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }"

# 2. Wipe the data directory
rm -rf ~/.api-audit

# 3. Restart and re-upload only what you want
pnpm start --no-open
curl -F "zip=@plugins/devctr-kv/dist/devctr-kv.zip" http://localhost:4560/api/plugins
```

**After this:** hard-reload the browser (`Cmd+Shift+R`) so the new browser half loads.
Plugin pages and the "去登录" button will work as designed.

## Why is the host so slow to start / eat so much RAM

Two knobs control the cost ceiling:

| Knob | Where | Default | When to lower | When to raise |
|---|---|---|---|---|
| Ring buffer capacity | `packages/host/src/client/ring-buffer.ts` | 50 (was 1000) | Personal tool, big httpbin bodies | High-traffic multi-user host |
| Audit page poll interval | `apps/web/src/pages/AuditPage.tsx` | 5 s (was 2 s) | Tighter battery + CPU on the dev box | Many plugins pushing |

Each audit record stores the full response body up to `MAX_BODY_BYTES` (1 MiB). 1000 records × 1 MiB ≈ 1 GiB in the ring buffer. With 50 records and typical httpbin bodies, the host sits at ~110 MiB RSS.

Both are also commit-time tuned; if you change them, document the reason in the commit body.

## Audit redaction: none, by design

This is a personal audit workbench, not a SaaS. `packages/host/src/client/audit-middleware.ts`
records headers **as-is** (incl. `Authorization: Bearer …`) and sends them **as-is** to the
backend. There is no `redactCredentials` step in the request path.

If you ever add a redaction step, do not mutate `ctx.headers` in the middleware — every
downstream layer (including `performFetch`) reads from `ctx.headers`, and rewriting the
authorization header with `{present, hash}` placeholder causes the backend to return
`401 invalid token` for every authenticated call. The two valid patterns:

- **Redact in the record only**: build the record from `redactedHeaders` but keep
  `ctx.headers` untouched, OR
- **Don't redact at all** (current choice — this is a personal tool, the audit value comes
  from seeing the real request).

`packages/core/src/credentials.ts` still exports `redactCredentials` and `SENSITIVE_HEADER_NAMES`
for future work (e.g. the planned field-usage counter that wraps the response with a Proxy).
Don't remove them — just don't wire them into the request pipeline.

## `pluginRunId` looks like it's churning in the UI

Two distinct phenomena, easy to confuse:

- **REST `/api/plugins` is stable.** The id → runId map does not change between samples
  if the host isn't being restarted repeatedly. The sub-second-1-on-1 identity is preserved.
- **The web shell re-installs browser halves on every snapshot push** that mentions the
  plugin, and the user (you) keeps pressing reload / uploading fresh zips → each new upload
  mints a new `run-N`. If you see 100+ runs in `/api/plugins`, you've been uploading a lot
  without clearing the data dir — see the first section.

Sanity probe:

```bash
# Two samples, a few seconds apart, same plugin id
curl -s http://localhost:4560/api/plugins > /tmp/a.json
sleep 6
curl -s http://localhost:4560/api/plugins > /tmp/b.json
node -e "const a=require('/tmp/a.json').data, b=require('/tmp/b.json').data; \
  console.log(a.map(p=>p.id+'='+p.pluginRunId).join(',')); \
  console.log(b.map(p=>p.id+'='+p.pluginRunId).join(','))"
```

If the two lines differ, the host is genuinely reloading (probably hot-reload or restart).
If they're equal, the UI churn is browser-side reconcile noise, not the host.

## Smoke a fresh end-to-end (login → query → audit)

```bash
# 1. Probe the backend directly with a Python httpx script in .tool/kv-login-tester/
cd .tool/kv-login-tester && uv run python scripts/probe.py
#    expect: login 200, /user/info 200 with your id, /groups 200 with shared + 个人空间

# 2. Start host, upload the demo plugin, drive the live UI via the MCP browser
pnpm start --no-open
curl -F "zip=@plugins/devctr-kv/dist/devctr-kv.zip" http://localhost:4560/api/plugins

# 3. In the browser:
#    - Open http://localhost:4560/devctr-kv
#    - Type credentials into the DevCtr login form
#    - TopBar tabs (概览/工作组/键管理/用户) appear after login
#    - Each tab triggers an audit record with initiator=devctr-kv
#    - Tokens are visible in the audit log — that's the design, not a leak
```

The plugin-sync tab in the web shell **deduplicates by `pluginRunId`**, so opening the
plugin page in two tabs is fine; only the first open loads the browser half.

## What is `audit-middleware` doing

`createAuditMiddleware({ buffer })` returns the outer link of the onion chain (one link, in
current setup). Its job on each request:

1. Open the duration timer.
2. Call `next()` → `performFetch(ctx)` → `undici.fetch(url, init)` (via `HostAuditClient`).
3. Build an `AuditRecord` from the response envelope.
4. Persist + push to the ring buffer (serialized on an internal promise chain so
   `nextId()` allocations stay monotonic).
5. Trigger `onPush` (broadcast `audit.append` over WS to all connected browsers).

There is **no credential mutation** in the middleware — both the record and the live request
share the same `ctx.headers` value (deliberately, see "Audit redaction" above).

## What the plugin sync flow does on connect

1. `connectRpc` opens the WS to `/ws`.
2. Sends `snapshot.request`; host replies with `snapshot.respond` containing the current
   plugin list and audit tail.
3. `BrowserRuntime.reconcile(snap)` fetches the browser source over REST for every plugin
   that has a `halves.browser.entry`, blob-imports it, and runs the default export on the
   browser cordis Context (`ctx.register.pages` + the half's own `installPlugin` setup).
4. Subsequent `plugin.changed` (upload) or WS re-apply events trigger another reconcile.
5. The half's `ctx.pages.register({ path, title, Component, layout, routes })` populates the
   shared `PageRegistry` that the web shell subscribes to via `useSyncExternalStore`.

If a half fails to import, the error is logged and the entry skipped — the rest of the
plugin list still loads.

## Cordis context: one root, many fibers

`packages/host/src/cordis/cordis-shim.ts` creates the single root `Context`. Every plugin
half runs as its own fiber via `ctx.registry.plugin(halfFn, { name: manifest.id })` and
`await fiber.await()`. When the plugin is replaced, `await fiber.dispose()` runs the fiber's
dispose chain; the next upload then loads a fresh module evaluation, which is why **plugin
state must be in `ctx.set(...)` not in module-scope `let`** if you want it to survive replace
(rarely needed — devctr-kv's `let token` resets on every replace, which is currently a bug
for long sessions; the simple workaround is "log in again after replace", tracked in
`docs/superpowers/sdd/` if it becomes a real pain point).
