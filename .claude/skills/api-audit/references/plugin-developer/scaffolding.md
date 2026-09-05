# Scaffolding — `npx @flowot/nx-pn init <name>` (third-party plugin DX)

Ships in v0.2.0. One command closes the third-party plugin author loop:
scaffold → build → install → verify → publish. No manual template copying
from `plugins/echo` anymore.

## CLI

```bash
npx @flowot/nx-pn init <name> [--dir <path>] [--force]
```

| Flag | Meaning |
|---|---|
| `--dir <path>` | Output directory (default `./<name>`) |
| `--force`, `-f` | Overwrite an existing non-empty directory |

The `name` must match `^[a-z0-9][a-z0-9-]{0,63}$` (no trailing hyphen) and
derives four fields:

| Name | manifest id | title (Title Case) | page path | React component |
|---|---|---|---|---|
| `my-plugin` | `my-plugin` | `My Plugin` | `/my-plugin` | `MyPlugin` |
| `gh-issues` | `gh-issues` | `Gh Issues` | `/gh-issues` | `GhIssues` |

Invalid names (uppercase, underscore, non-ASCII, >64 chars, leading/trailing
hyphen) are rejected **before any file is written** — no half-scaffolds.

## The 9 scaffolded files

```
<dir>/
├── manifest.json          # halves host+browser, page at /<name> (build-generated)
├── package.json           # main/exports → ./host.js + api-audit.manifest
├── host.ts                # cordis plugin: hello-call on activation
├── browser.tsx            # React counter page, closure-captured ctx
├── tsconfig.json          # extends ../../tsconfig.base.json
├── README.md              # build/install/develop/publish doc
├── scripts/build-zip.mjs  # esbuild + STORED zip + externals assertions
├── scripts/dev.mjs        # dev watch loop: rebuild + hot-upload on save (npm run dev)
└── .gitignore             # dist/, node_modules/, *.zip
```

**Dual install path by design**:

- `main`/`exports` point at `./host.js` at the **package root** —
  the host's `resolveHostEntry` (`packages/host/src/plugins/installer.ts:316-328`)
  resolves `pkg.main` and imports from there, so
  `npx @flowot/nx-pn add file:.` works
- `scripts/build-zip.mjs` emits `dist/<id>.zip` (STORED, manifest + host.js +
  browser.js) — the zip upload path also works

**Built-in externals assertions** (copied from echo's build-zip pattern):
- `host.js` must keep `cordis` external (esbuild `external: ['cordis']`)
- `browser.js` must keep React + react-router-dom external — regex check on
  the compiled output; would silently double-React otherwise

## The author loop

```
1. npx @flowot/nx-pn init my-plugin
2. cd my-plugin && npm install
3. Edit host.ts (server logic) / browser.tsx (UI)
4. npm run build          # typecheck + esbuild + zip
5. npx @flowot/nx-pn add file:.       (npm path, ledger; takes effect on host restart)
   or curl -F zip=@dist/<id>.zip http://localhost:4560/api/plugins   (hot-add, live)
   or POST /api/plugins/install {"spec":"file:<abs-path>"}            (hot-add + hot-update)
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
| CLI wiring (`--dir`/`--force`/positional/usage text) | `apps/cli/src/main.ts` (`parseArgs`, `runInit`) |
| Pure functions + scaffold I/O | `apps/cli/src/init.ts` (`validateName`, `nameToTitle`, `nameToPath`, `nameToComponent`, `renderTemplate`, `scaffoldPlugin`) |
| Template sources (9 files, `{{var}}` placeholders) | `apps/cli/templates/plugin-basic/` |
| Unit + e2e tests (28) | `apps/cli/src/init.test.ts` |

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

- **New template file added** → update "The 9 scaffolded files" table +
  `scaffoldPlugin`'s `fileList` in `init.ts` must stay in lockstep
- **Template placeholder added** → document the new var in this file and in
  `apps/cli/templates/plugin-basic/README.md`
- **New flag added to init** → update the CLI table + `main.ts` usage text
- **`resolveHostEntry` contract changes** → update "Dual install path by
  design" (main/exports must stay resolvable from package root)

## Full example

See the scaffolded `demo-plugin` verification in git history (commit
`52e76d2`): init → build → `add file:` → `/api/audit` record shows
`initiator: "demo-plugin"`, `reqHeaders.user-agent: "api-audit-demo-plugin/0.1.0"`.
