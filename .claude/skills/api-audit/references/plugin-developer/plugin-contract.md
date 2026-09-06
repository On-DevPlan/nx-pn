# Plugin protocol — the contract for plugin authors

## Scaffolding a new plugin (start here)

Don't hand-copy template files — `init` generates them for you:

```bash
npx @flowot/nx-pn init <name>    # → 9 files (manifest, package.json, host.ts,
                                  #    browser.tsx, tsconfig, README,
                                  #    scripts/build.mjs, .gitignore)
```

Derives the manifest id, page title, page path, and React component name from
`<name>`. The scaffolded plugin supports both install paths below out of the
box. Full details: `references/scaffolding.md`.

## Two plugin sources

### 1. Zip dual-half (existing path)

A zip with three files: `manifest.json`, `host.js`, `browser.js`. Upload via
`POST /api/plugins` (multipart) or the Plugins page UI. The host extracts,
validates, compiles the host half with esbuild, imports it, and registers the
fiber.

Example: `plugins/example-api/`

### 2. npm install-by-name (new path)

A plain npm package whose `package.json` carries the manifest under
`api-audit.manifest` and points `main` (or `exports["."]`) at an ESM host half.
Install via `npx @flowot/nx-pn add <spec>` or `POST /api/plugins/install`.

Example format:
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "./host.js",
  "api-audit": {
    "manifest": { "id": "my-plugin", "version": "1.0.0", "title": "My Plugin" },
    "browser": "./browser.js"
  }
}
```

## Required manifest fields

```ts
{
  schemaVersion: 1,
  id: string,           // ^[a-z0-9-]+$, 1-64 chars
  version: string,      // semver ^\d+\.\d+\.\d+(-[\w.]+)?$
  title: string,        // 1-200 chars
  halves: {
    host?: { entry: string, pages?: [...], inject?: string[] },
    browser?: { entry: string, pages?: [...], inject?: string[] }
  },
  inject?: string[]     // top-level service deps
}
```

- `pages[].path`: `^/[a-zA-Z0-9_\-/.:]*$`, must start with `/`
- `pages[].order`: integer 0-10000 (default 100, sort weight)
- `pages[].layout`: `'shell'` (default, page renders inside the shell's `<main>`) or
  `'fullscreen'` (plugin claims the whole viewport — sidebar/brand hidden)
- `pages[].routes[]`: plugin-owned sub-routes `{ path }` for fullscreen pages; `path` is
  RELATIVE to the page prefix (`/detail`, or `/` / `''` for the bare prefix) and must
  match `^/[a-zA-Z0-9_\-/.:]*$`. Declared for docs/validation only — the browser half
  supplies the Components (see `references/fullscreen.md`).
- `entry`: filename ending in `.js/.jsx/.ts/.tsx`
- At least one of `host` or `browser` is required

## Host half contract (Node ESM)

```ts
// host.ts — compiled to host.js with:
//   esbuild → bundle, platform=node, format=esm, external=['cordis']

export default (ctx, config) => {
  // config.name = manifest.id
  // ctx.auditClient.get(url, config?) → audited, attributed
  // ctx.auditClient.post(url, body?, config?) → audited, attributed
  // ctx.auditClient.put/patch/delete — same shape
  // ctx.on(event, handler) → auto-disposed with fiber
  // ctx.logger.info/warn/error
  // ctx.registry.plugin(fn, { name }) → register a sub-plugin
}
```

**Attribution**: any `ctx.auditClient` call resolves the caller fiber →
lifecycle registry → `initiator = manifest.id`. Verified in
`packages/host/src/__tests__/hot-add.e2e.test.ts`.

**Optional inject** (declare service deps so cordis delays activation):
```ts
;(plugin as typeof plugin & { inject?: string[] }).inject = ['auditClient']
```

**Lifecycle**:
- Register: `ctx.registry.plugin(fn, { name })` → `await fiber.await()`
- Stop: `await fiber.dispose()`
- Restart: re-install via zip upload or npm ledger replay

**Re-upload dedup**: uploading or installing a plugin with an existing
`manifest.id` automatically replaces the old run (the host fiber is disposed
and the browser-half is retracted on every connected web shell). The new run
gets a fresh `pluginRunId`; the old one is gone. The response carries
`replaced: [<old runId>, ...]` (empty for a fresh upload) so callers can see
the eviction. At any instant at most one active run per `manifest.id` exists
in the lifecycle + the browser's PageRegistry.

## Browser half contract (ESM, shared React)

```tsx
// browser.tsx — compiled to browser.js with:
//   esbuild → bundle, platform=browser, format=esm, jsx=automatic,
//   external=['react','react-dom','react/jsx-runtime','react-dom/client','react-router-dom','cordis']

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

export default (ctx, config) => {
  // ctx.pages.register({ pluginId, path, title, order?, icon?, Component })
  //   → adds a sidebar entry + route
  // ctx.auditClient.get/post/put/patch/delete → proxied to host over WS RPC
  // ctx.hostCall.hostCall(event, payload?) → invokes a host-half event
  //   handler (`<plugin>/<action>`, registered via ctx.on on the HOST
  //   context) over a `tool.invoke` WS round-trip. Resolves with the
  //   handler's ApiResult; structured errors (no handler, backend
  //   failure) survive the pending table verbatim.
  // ctx.logger.info/warn/error

  const Page = () => {
    const [n, setN] = useState(0)
    return <button onClick={async () => {
      const r = await ctx.auditClient.get('https://api.example/...')
      setN(r.status)
    }}>call</button>
  }

  ctx.pages.register({
    pluginId: 'my-plugin',
    path: '/my-page',
    title: 'My Page',
    order: 200,
    Component: Page,
  })
}
```

**Critical**: `react`, `react-dom`, `react/jsx-runtime`, `react-dom/client`,
`react-router-dom`, and `cordis` must be **external** in the esbuild config. The
app's import map resolves them to the shared vendor chunk (spec §5.2.2) so
hooks and context are unified with the shell.

The `scripts/build.mjs` pattern asserts this post-compilation with a regex
check on the output (looks for `from "react"` in the compiled `browser.js`).

**Closure capture pattern**: define the Component inside the plugin function so
it closes over `ctx`. No window hacks or context prop-drilling needed.

```tsx
const plugin = (ctx) => {
  const MyPage = () => {
    // ctx is in scope via closure
    return <button onClick={() => ctx.auditClient.get('/...')}>go</button>
  }
  ctx.pages.register({ pluginId: 'my-plugin', path: '/my-page', title: 'My', Component: MyPage })
}
```

**Fullscreen + local sub-routes**: pass `layout: 'fullscreen'` plus a `routes[]`
array — the plugin claims the whole viewport (no sidebar) and renders its OWN
`<Routes>` under its prefix. Every registered route Component must be
self-sufficient (carry the plugin's own top bar); the flat `Component` becomes
the `*` fallback inside the plugin's local routing.

```tsx
ctx.pages.register({
  pluginId: 'my-plugin',
  path: '/my-plugin',
  title: 'My Plugin',
  layout: 'fullscreen',
  routes: [
    { path: '/', Component: DashboardView },   // bare prefix
    { path: '/detail', Component: DetailView }, // /my-plugin/detail
  ],
  Component: DashboardView, // '*' fallback
})
```

Full walkthrough: `references/fullscreen.md`.

## Replay

`POST /api/replay { recordId }` re-invokes the same call (through `auditClient`)
with `initiator: "replay:<recordId>"`, producing a new `AuditRecord` with
`replayOf: <recordId>`.

## Distributing

- **Zip**: build with `esbuild` (see `plugins/example-api/scripts/build.mjs`),
  upload via `/api/plugins` or the Plugins page
- **npm**: publish a package with `api-audit.manifest` + `api-audit.browser` in
  `package.json`, install via `npx @flowot/nx-pn add <name>`

## Third-party author quick reference

| Task | Command |
|---|---|
| Scaffold | `npx @flowot/nx-pn init <name>` |
| Build | `cd <name> && npm install && npm run build` |
| Local install (hot, live) | `curl -F zip=@dist/<name>.zip http://localhost:4560/api/plugins` |
| Local install (ledger, next start) | `npx @flowot/nx-pn add file:./<name>` |
| REST hot-install / hot-update | `POST /api/plugins/install {"spec":"file:<abs-path>"}` |
| Publish | `npm publish` → users: `npx @flowot/nx-pn add <name>` |

## Full example

See `plugins/example-api/` (activation-time GET) and `plugins/enco/`
(user-driven form with POST/PUT/DELETE). The walkthrough for the form-style
plugin is at `references/walkthrough-echo.md` (note: the doc still names
`echo/`, but the current plugin source is at `plugins/enco/` after the 0.4.0
refactor).
