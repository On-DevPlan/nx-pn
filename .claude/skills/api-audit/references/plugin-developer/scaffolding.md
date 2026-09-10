# Scaffolding — `npx @flowot/nx-pn init <name>` (third-party plugin DX)

Ships in v0.2.0. One command closes the third-party plugin author loop:
scaffold → build → install → verify → publish. No manual template copying
from `plugins/echo` anymore.

## CLI

```bash
npx @flowot/nx-pn init <name> [--dir <path>] [--force] [--no-skill]
```

| Flag | Meaning |
|---|---|
| `--dir <path>` | Output directory (default `./<name>`) |
| `--force`, `-f` | Overwrite an existing non-empty directory |
| `--no-skill` | Skip installing the `.claude/` dev skill (installed by default) |
| `--layout shell\|fullscreen` | Browser-half layout (default `shell`): picks `browser-sidebar.tsx` or `browser-fullscreen.tsx` |

The `name` must match `^[a-z0-9][a-z0-9-]{0,63}$` (no trailing hyphen) and
derives four fields:

| Name | manifest id | title (Title Case) | page path | React component |
|---|---|---|---|---|
| `my-plugin` | `my-plugin` | `My Plugin` | `/my-plugin` | `MyPlugin` |
| `gh-issues` | `gh-issues` | `Gh Issues` | `/gh-issues` | `GhIssues` |

Invalid names (uppercase, underscore, non-ASCII, >64 chars, leading/trailing
hyphen) are rejected **before any file is written** — no half-scaffolds.

## The 11 scaffolded files (workspace layout)

```
<dir>/
├── package.json              # devDeps: @flowot/nx-pn (embedded base); scripts: dev/shared-dev/build/test/typecheck
├── tsconfig.json             # baseUrl: .; paths: @flowot/plugin-* → ./plugins/*/src
├── scripts/dev.mjs           # SELF-CONTAINED standalone dev loop: probes/spawns its own host,
│                              # startup-uploads every plugins/<id>/, then watches plugins/
│                              # (node:fs.watch → rebuild → POST zip; runId dedup hot-replace).
├── scripts/shared-dev.mjs    # same loop, but joins (or creates) one shared host on :4560
├── scripts/build.mjs         # esbuild + STORED zip + cordis/React externals assertions;
│                              #   discovers the browser half via the browser*.tsx glob
├── .claude/                  # dev skill copied from the template (skip with --no-skill)
└── plugins/<name>/
    ├── package.json          # peerDeps: @flowot/nx-pn-host; devDeps: @flowot/nx-pn-client
    ├── tsconfig.json         # extends ../../tsconfig.json
    ├── manifest.json         # halves: { host: { entry: host.js }, browser: { entry: browser.js } }
    ├── host.ts               # cordis plugin: boot counter + hello-call + 3 tool endpoints
    ├── host.test.ts          # node:test smoke tests for the tool endpoints
    └── browser-sidebar.tsx   # React page, closure-captured ctx (or browser-fullscreen.tsx
                              #   when scaffolded with --layout fullscreen)
```

> Note: this is the **workspace** layout (master plan v2 之后). dev.mjs lives at
> the workspace root, not per-plugin. Plugins live under `plugins/<name>/`.
> `npx @flowot/nx-pn init <name>` creates this 11-file scaffold plus the
> `.claude/` dev skill (default on). Only ONE browser file exists — the layout
> is fixed at scaffold time; there is no `browser.tsx`.

**Install paths**:

- **Zip (works — default)**: `scripts/build.mjs <id>` emits
  `<workspace>/dist/<id>.zip` (STORED, manifest + host.js + browser.js) —
  **workspace-root `dist/`, not per-plugin**. `scripts/dev.mjs` startup-uploads
  this zip; you can also `curl -F zip=@dist/<id>.zip http://localhost:4560/api/plugins`.
- **npm ledger (`npx @flowot/nx-pn add file:<dir>`)**: NOT wired for the workspace
  layout. The installer builds the manifest from `package.json["api-audit"]`
  (`installer.ts`), which the scaffolded plugin package.json does not carry — it
  ships a separate `manifest.json` for the zip path. Use the zip path until an
  `api-audit` block is scaffolded into the plugin package.json.

**Built-in externals assertions** (in scripts/build.mjs):
- `host.js` must keep `cordis` external (esbuild `external: ['cordis']`)
- `browser.js` must keep React + react-router-dom external — regex check on
  the compiled output; would silently double-React otherwise

## The author loop

```
1. npx @flowot/nx-pn init my-plugin
2. cd my-plugin && npm install
3. Edit host.ts (server logic) / browser-sidebar.tsx (UI)
4. npm run build          # esbuild + STORED zip → dist/<id>.zip (npm run typecheck separately)
5. npm run dev            # starts a host and hot-uploads every plugins/<id>/
   # — or, against an already-running host:
   curl -F zip=@dist/<id>.zip http://localhost:4560/api/plugins   (hot-add, live)
6. Verify: sidebar entry appears, /audit shows initiator="<name>"
7. npm publish            # users install via npx @flowot/nx-pn add <name>
```

**Hot-add / hot-update**: REST install against a running host registers the
fiber live (no restart). Re-installing the same id **upserts** — the old
fiber is disposed, a new `pluginRunId` allocated, and the browser half is
re-pushed to every connected web shell (see `usage.md` hot-reload table).

`npx @flowot/nx-pn add` is one-shot ephemeral: it writes the npm ledger and
takes effect on the next host start (`restartNpmPlugins`).

## Implementation map

| Piece | Location |
|---|---|
| CLI wiring (`--dir`/`--force`/`--no-skill`/`--layout`/positional/usage text) | `apps/cli/src/main.ts` (`parseArgs`, `runInit`, `runInitPlugin`) |
| Pure functions + scaffold I/O + `.claude/` skill copy | `apps/cli/src/init.ts` (`validateName`, `nameToTitle`, `nameToPath`, `nameToComponent`, `renderTemplate`, `scaffoldPlugin`, `scaffoldPluginInWorkspace`, `copyDir`, `pathExists`) |
| Template sources (11 files + `.claude/` skill, `{{var}}` placeholders) | `apps/cli/templates/plugin-workspace/` |
| Unit + e2e tests (41) | `apps/cli/src/init.test.ts` |

Key facts:

- Templates are plain files with `{{var}}` placeholders — zero template-engine
  deps; `renderTemplate` uses the regex `/\{\{([\w-]+)\}\}/g` (the `[\w-]+`
  char class includes hyphens — `\w` alone misses keys like `{{user-agent}}`)
- Template dir resolution tries `lib/../templates` (compiled/prod) then
  `cwd()/apps/cli/templates` (dev) — `locateTemplateDir` in `init.ts`
- `scaffoldPlugin` refuses non-empty dirs unless `force: true` (checks for an
  existing `package.json`)
- Version uniformity: the whole `@flowot/nx-pn*` family bumps together; the
  npm-publish workflow verifies it (`Verify uniform family version` step)

## When to sync this skill (post-feature)

- **New template file added** → update "The 11 scaffolded files" table; the
  `rootFiles`/`pluginFiles` lists in `init.ts` must stay in lockstep (the
  `template ↔ fileList lockstep` suite in `init.test.ts` enumerates the
  template tree and fails if they drift)
- **Template file renamed/removed** → grep the template for the old name: the
  mirror ends (`build.mjs` browser-half glob, plugin `tsconfig.json` include,
  `package.json` scripts, this doc) all referenced `browser.tsx` after it was
  renamed and failed only at scaffold run time
- **Template placeholder added** → document the new var in this file
- **New flag added to init** → update the CLI table + `main.ts` usage text
- **`resolveHostEntry` contract changes** → update "Dual install path by
  design" (main/exports must stay resolvable from package root)

## Full example

See the scaffolded `demo-plugin` verification in git history (commit
`52e76d2`): init → build → `add file:` → `/api/audit` record shows
`initiator: "demo-plugin"`, `reqHeaders.user-agent: "api-audit-demo-plugin/0.1.0"`.
