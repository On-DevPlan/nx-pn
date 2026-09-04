# CLI automation — driving nx-pn from the terminal (plugin-developer surface)

> **Audience:** the plugin developer who wants to build, install, debug, and
> observe their plugin WITHOUT opening the browser — and who wants an agent
> (Claude, a CI job, a script) to do the same. Ships in v0.3.1. The CLI is a
> short-lived client: one command boots (or reuses) the host, does its thing,
> and exits — no daemon to keep alive.

## Command surface

```bash
# Plugin lifecycle
npx @flowot/nx-pn init <name>                # scaffold a plugin (8 template files)
npx @flowot/nx-pn build <pluginDir>          # run the plugin's own build-zip.mjs
npx @flowot/nx-pn add <spec>                 # install by npm name / file:./dir
npx @flowot/nx-pn plugin list                # installed plugins (live host, else cold)
npx @flowot/nx-pn plugin show <id|runId>     # one plugin's manifest
npx @flowot/nx-pn plugin stop <runId>        # fiber.dispose (live host only)
npx @flowot/nx-pn plugin remove <runId>      # stop + evict registry (live host only)
npx @flowot/nx-pn plugin uninstall <id>      # remove + drop npm ledger (live host)

# Audit request trail
npx @flowot/nx-pn audit list [filters] [--format json|jsonl|csv|table]
npx @flowot/nx-pn audit lastId               # newest id, bare number (polling)

# Host
npx @flowot/nx-pn [--port N] [--data-dir DIR]   # (default) start the web server
```

Global flags on every command: `--port <n>` (default 4560), `--data-dir <dir>`
(default `~/.api-audit`). **Every read/query command works even when the host
is not running** — it cold-starts an ephemeral host over the same `--data-dir`
and reads the durable storage domains directly. The only actions that require a
running host are the live-fiber ones (`plugin stop|remove|uninstall`), which
can't touch a cold host's fiber registry.

## Audit query language

`audit list` shares its filter/sort/limit vocabulary with the host's
`GET /api/audit` — one set of predicates, two retrieval paths (live REST or
cold domain read), so results never drift.

| Flag | Meaning | Example |
|---|---|---|
| `--since-id N` | records strictly newer than N | `--since-id 42` |
| `--limit N` | max records (default unlimited) | `--limit 20` |
| `--method M` | exact HTTP method | `--method GET` |
| `--status S` | exact response status | `--status 404` |
| `--url SUBSTR` | substring of request url | `--url /api/v1` |
| `--initiator I` | substring of initiator (`core`/`replay:<id>`/`<pluginId>`) | `--initiator my-plugin` |
| `--order asc\|desc` | sort by id (default `desc`, newest first) | `--order asc` |
| `--format ...` | output shape | `--format jsonl` |

Formats:
- **json** — one `{ ok, count, records }` document
- **jsonl** — one compact JSON record per line (best for `| jq`, grep, CI)
- **csv** — header + `id,ts,method,status,url,durationMs,initiator`
- **table/human** — aligned columns (interactive default)

> Audit records keep credential headers (Authorization / cookies / x-api-key)
> **verbatim** — no redaction (product decision). This is what makes debugging
> auth failures possible; keep `--data-dir` private (it is `~/.api-audit` by
> default) and treat exported jsonl as sensitive.

## Workflows (copy-paste)

### Build + hot-add a plugin, verify it produces audited traffic

```bash
# 1. Build your plugin's zip
npx @flowot/nx-pn build ./my-plugin            # → my-plugin/dist/my-plugin.zip

# 2. Start a host (background), or rely on the CLI cold path
npx @flowot/nx-pn --no-open &
sleep 2

# 3. Add the built zip → hot-loads into the running host
npx @flowot/nx-pn add file:./my-plugin/dist/my-plugin.zip

# 4. Exercise the plugin (e.g. its host-half boot fires an audited request).
#    Now the trail is queryable:
npx @flowot/nx-pn audit list --initiator my-plugin --format jsonl
```

### Debug "why is my auth call failing"

```bash
# Everything my-plugin sent, most recent first, full headers visible
npx @flowot/nx-pn audit list --initiator my-plugin --status 401 --format jsonl
# → the Authorization header is right there in reqHeaders, verbatim
```

### Agent loop over the audit trail

An agent can iterate: run a scenario → `audit lastId` → poll new records
after each step → diff behavior. Example (bash):

```bash
BASE=$(npx @flowot/nx-pn audit lastId 2>/dev/null || echo 0)
# ... drive your plugin / host ...
npx @flowot/nx-pn audit list --since-id "$BASE" --initiator my-plugin --format jsonl
```

### Cold-start check "is my plugin installed & what version" (no host)

```bash
npx @flowot/nx-pn plugin list --format json
npx @flowot/nx-pn plugin show my-plugin
```

## Design notes (why it works this way)

- **Probe → hot or cold.** Every command asks "is a host alive on `--port`?"
  (GET /api/plugins as liveness). Alive → drive its REST routes (real fiber
  semantics, WS push to connected browsers). Dead → ephemeral host reads the
  durable storage domains, then exits. Same `--data-dir`, same result.
- **One query vocabulary.** `applyAuditQuery` lives in `@flowot/nx-pn-host`
  and is shared by `GET /api/audit` and the CLI cold path — filters/sort/limit
  behave identically over a live host or a cold data dir.
- **Build is the plugin's job.** `build <dir>` shells out to the plugin's own
  `scripts/build-zip.mjs` (each plugin owns its esbuild externals / zip
  writer); the CLI never re-implements bundling.
- **Live-fiber actions need a live host.** `plugin stop/remove/uninstall`
  operate on fibers that only exist in a running host's lifecycle — cold-start
  cannot reach them, so they error with a clear hint if no host is up.

## Related

- `scaffolding.md` — `init` command (scaffold → build → install → verify)
- `plugin-contract.md` — what a plugin package must declare
- `walkthrough-echo.md` — end-to-end with the echo plugin
- `../core-developer/storage.md` — where audit/plugin records live on disk
- `../core-developer/operations.md` — data-dir hygiene, killing a stuck host
