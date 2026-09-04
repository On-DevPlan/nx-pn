# @flowot/nx-pn

The `api-audit` npx entry (spec §2.2). Boots the Node-side host
(`@flowot/nx-pn-host`), serves the web UI, and opens a browser.

## Usage

```bash
# from the repo root, after `pnpm install && pnpm build`:
npx @flowot/nx-pn            # → http://localhost:4560
```

Commands:

```bash
npx @flowot/nx-pn init <name> [--dir <path>] [--force]
```

Scaffold a new plugin directory with 8 template files (manifest, package,
host.ts, browser.tsx, tsconfig, README, build-zip.mjs, .gitignore). The
`name` must match `^[a-z0-9][a-z0-9-]{0,63}$` and is used to derive the
manifest id, page title (`My Plugin`), page path (`/my-plugin`), and React
component name (`MyPlugin`).

| Flag | Meaning |
|---|---|
| `--dir <path>` | Output directory (default: `./<name>`) |
| `--force`, `-f` | Overwrite existing non-empty directory |

After scaffolding, `cd` into the directory, `npm install`, `npm run build`,
then upload the produced `dist/<name>.zip` to a running api-audit host.

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

- `bin/nx-pn.mjs` — the bin; loads the built `lib/main.js` and runs it.
- `src/main.ts` — `parseArgs` (pure, unit-tested) + `runCli` (startHost,
  banner, browser open, signal handling).
