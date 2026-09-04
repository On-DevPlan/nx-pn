# Fullscreen plugins + local (plugin-owned) routing

A plugin page normally renders flat inside the shell's `<main>` (sidebar
visible). With `layout: 'fullscreen'` the plugin instead claims the WHOLE
viewport — the shell hides sidebar + brand — and manages its own sub-routes
under its prefix, enabling multi-view dashboards inside one plugin.

Reference implementation: `plugins/devctr-kv/` (the third plugin).

## The contract (client side)

`ctx.pages.register(entry)` accepts:

```ts
{
  pluginId: string
  path: string              // page PREFIX, e.g. '/devctr-kv'
  title: string
  order?: number
  icon?: string
  layout?: 'shell' | 'fullscreen'   // default 'shell'
  routes?: { path: string; Component: unknown }[]  // sub-routes, RELATIVE to prefix
  Component?: unknown       // flat view; fullscreen: '*' fallback inside local routing
}
```

- A `routes[].path` of `/` (or `''`) matches the BARE prefix
  (react-router v6 nested matching: the `''` child handles `<prefix>`).
- Other paths are relative: `/keys` mounts at `<prefix>/keys`.
- `routes[]` is opaque to the `PageRegistry` — it just flows through.

## The contract (manifest side)

```json
{
  "halves": {
    "browser": {
      "entry": "browser.js",
      "pages": [
        {
          "path": "/devctr-kv",
          "title": "DevCtr KV",
          "layout": "fullscreen",
          "routes": [{ "path": "/" }, { "path": "/keys" }]
        }
      ]
    }
  }
}
```

`layout` enum is `['shell','fullscreen']`; each `routes[].path` must match
`^/[a-zA-Z0-9_\-/.:]*$` or be `''`. Declared for docs/validation only — the
browser half supplies the Components.

## Shell behavior (apps/web/src/App.tsx)

- Registered pages split into `shellPages` (current flat behavior, sidebar
  NavLinks inside `<main>`) and `fullscreenPages`.
- Sidebar gains a `插件页面（全屏）` section with ONE NavLink per fullscreen
  page → its prefix.
- Each fullscreen page mounts `<Route path={`${prefix}/*`}>` whose element is
  `<div class="fullscreen-root">` + `PluginPageBoundary fullscreen` + the
  plugin's own `<Routes>` (`PluginLocalRoutes`): `/` → `''`, others stripped
  of the leading `/`, `page.Component` as the `*` fallback.
- `ShellLayout` hides sidebar/brand while `location.pathname` matches any
  fullscreen prefix (`prefix` exact or `prefix/…`). Navigating to `/audit`
  (or any shell route) brings the chrome back.
- The boundary's `fullscreen` variant renders the error box full-viewport
  with a 返回壳 button (navigate('/audit')).

## Plugin-side rules that make it work

1. **Every registered route Component must be self-sufficient.** The shell
   renders a registered Component standalone under the boundary — there is no
   shared plugin-level wrapper. devctr-kv wraps each view
   (`DashboardView`/`GroupsView`/`KeysView`/`UserView`) with its own `TopBar`
   (title + local NavLinks + 返回壳).
2. **State shared across views needs a store outside React.** Route switches
   unmount views, so devctr-kv keeps a module-closure auth store
   (`auth.loggedIn` + listener set + `useLoggedIn()` hook via `useState` +
   `useEffect(auth.subscribe)`) instead of lifting state to a parent that
   doesn't exist.
3. **Local nav uses absolute prefixed links.** `/devctr-kv/keys`, not
   `keys` — the local `<Routes>` is mounted under `<prefix>/*` but links
   resolve against the router root.
4. **CSS**: `.fullscreen-root { min-height: 100vh; width: 100% }` — the
   plugin owns the viewport; sidebar hiding is structural (not rendered).

## devctr-kv walkthrough

```
plugins/devctr-kv/
├── manifest.json          # layout:'fullscreen' + routes[/,/groups,/keys,/user]
├── host.ts                # JWT + devctr-kv/* event handlers (auditClient)
├── browser.tsx            # TopBar + 4 self-sufficient views + auth store
├── scripts/build-zip.mjs  # esbuild host+browser → dist/devctr-kv.zip
└── package.json / tsconfig.json
```

- `/devctr-kv` (概览): stats cards, quick-nav buttons, and one audited
  `ctx.auditClient.get('https://httpbin.org/get')` button — proves the plugin
  API works from a fullscreen view (record lands on /audit with
  `initiator: "devctr-kv"`).
- `/devctr-kv/keys` (键管理): KV CRUD table + editor + versions + shares.
- `/devctr-kv/groups` (工作组): group/member/invitation management.
- `/devctr-kv/user` (用户): login form (logged out) / profile + default
  group (logged in), sharing login state with the top bar via the auth store.

## Live smoke

```bash
cd plugins/devctr-kv && node scripts/build-zip.mjs
curl -F "zip=@dist/devctr-kv.zip" http://localhost:4560/api/plugins
```

- `http://localhost:4560/devctr-kv` → plugin top bar + 概览, NO sidebar/brand
- in-plugin nav → `/devctr-kv/keys` switches views (URL + view both change)
- 返回壳 → `/audit` with the shell sidebar restored
- echo / example-api flat pages unchanged (sidebar intact)

## Browser→host tool-event bridge (DONE)

Plugin browser halves call their **host half's event handlers** over the WS
RPC via the cordis service convention:

```tsx
// browser half — registered on the browser cordis context via
// `inject: ['pages', 'auditClient', 'hostCall']`
async function call(action: string, payload: Record<string, unknown>) {
  const r = await ctx.hostCall.hostCall(`<plugin>/${action}`, payload)
  // r is the host half's ApiResult ({ ok, data?, error?, status? })
}
```

The host half registers handlers with cordis's standard `ctx.on`:

```ts
// host half — registered on the HOST cordis context
function reg(action: string, handler: (p: Record<string, unknown>) => Promise<ApiResult>) {
  ctx.on(`<plugin>/${action}`, (payload) => handler(payload ?? {}).catch(...))
}
reg('login', async (p) => {
  const res = await ctx.auditClient.post('https://api.example/login', JSON.stringify(p), { headers: authHeaders() })
  // ...store JWT, return ApiResult...
  return { ok: true, data: { token } }
})
```

Wire shape (spec §4.5.1): browser sends a `tool.invoke` frame
`{ event, payload, pluginRunId }`; host dispatches on its cordis context
with the result-returning `serial` mode and replies with the handler's
ApiResult wrapped in `{ ok, data }`. `pluginRunId` is logging-only
attribution (never a hard fail). No-listener replies are a structured
`{ ok: false, error: 'no handler for <event>' }`; unexpected handler
faults are an rpc-level `{ ok: false, error: { code: 'rpc/tool-error' } }`.

**Important** — the call shape is `ctx.hostCall.hostCall(event, payload)`,
NOT `ctx.hostCall(event, payload)`. Cordis services expose methods on the
the prototype (matching `ctx.auditClient.get(url)` and `ctx.pages.register(entry)`);
the traceable returns the service instance, not a flat callable.
