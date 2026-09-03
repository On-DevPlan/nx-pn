# @api-audit/cli

The `api-audit` npx entry (spec §2.2). Boots the Node-side host
(`@api-audit/host`), serves the web UI, and opens a browser.

## Usage

```bash
# from the repo root, after `pnpm install && pnpm build`:
npx api-audit            # → http://localhost:4560
```

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `4560` | HTTP/WS port (`0` = ephemeral) |
| `--data-dir <dir>` | `~/.api-audit` | Plugin zips + compiled cache live here |
| `--no-open` | — | Skip auto-opening the browser |
| `-h`, `--help` | — | Usage text |

`Ctrl-C` (SIGINT) or SIGTERM shuts the host down cleanly: plugin fibers
dispose first, then WS, then HTTP.

## Layout

- `bin/api-audit.mjs` — the bin; loads the built `lib/main.js` and runs it.
- `src/main.ts` — `parseArgs` (pure, unit-tested) + `runCli` (startHost,
  banner, browser open, signal handling).
