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
├── scripts/build.mjs  # esbuild host+browser → dist/devctr-kv.zip
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
cd plugins/devctr-kv && node scripts/build.mjs
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

---

# Component-internal routing — the plugin owns its sub-routes

The shell is just the outer Router. The plugin's fullscreen view brings its **own
nested `<Routes>`** and its **own NavLink/useNavigate** inside the prefix. This
section walks through the actual code so you can build your own.

## Shell-side mount (one line, but it matters)

`apps/web/src/App.tsx`:

```tsx
{fullscreenPages.map((p) => (
  <Route
    key={`${p.pluginId}:${p.path}`}
    path={`${p.path}/*`}            // splat — any sub-path
    element={<FullscreenSlot page={p} />}
  />
))}
```

The `*` is the splat — react-router v6 routes the deepest matching `<Route>` to the
prefix's subtree. `FullscreenSlot` then mounts a fresh `<Routes>` (yes, nested) for
the plugin's own local nav. The shell does NOT know what sub-paths the plugin defines.

`PluginLocalRoutes` (also in App.tsx) is the bridge from the manifest's `routes[]`
to react-router v6 nested routes:

```tsx
function PluginLocalRoutes({ routes, fallback }) {
  return (
    <Routes>
      {routes.map((r, i) => {
        // A path of '/' becomes '' so it matches the bare <prefix>.
        // Other paths are stripped of the leading '/' since the local
        // <Routes> is mounted under `<prefix>/*` already.
        const rr = r.path === '/' ? '' : r.path.replace(/^\//, '')
        return <Route key={`${r.path}:${i}`} path={rr}
                      element={<RouteView Component={r.Component} />} />
      })}
      {fallback !== undefined && <Route path="*" element={<RouteView Component={fallback} />} />}
    </Routes>
  )
}
```

The `Component: devctr-kv/Component` (the `pages.register({ ... Component: DashboardView })`)
becomes the `path="*"` fallback so undeclared sub-paths still render something.

## Plugin-side: the fullscreen view assembly

`plugins/devctr-kv/browser.tsx` shows the canonical pattern. **Every route
Component is self-sufficient** (carries its own TopBar) because route switches
unmount views and there's no shared parent to own the chrome:

```tsx
const DashboardView = () => (
  <>
    <TopBar />
    <div className="page">
      <Dashboard onLoginNeeded={() => navigate('/devctr-kv/user')} />
    </div>
  </>
)

const GroupsView = () => (<><TopBar /><div className="page"><GroupsPanel /></div></>)
const KeysView   = () => (<><TopBar /><div className="page"><KvPanel /></div></>)
const UserView   = () => (<><TopBar /><div className="page"><UserPanel /></div></>)

ctx.pages.register({
  pluginId: id,
  path: '/devctr-kv',
  title: 'DevCtr KV',
  layout: 'fullscreen',
  routes: [
    { path: '/',       Component: DashboardView },
    { path: '/groups', Component: GroupsView },
    { path: '/keys',   Component: KeysView },
    { path: '/user',   Component: UserView },
  ],
  Component: DashboardView,   // fallback for unknown sub-paths
})
```

## TopBar — plugin's own nav bar (rendered inside every view)

```tsx
const TopBar = () => {
  const loggedIn = useLoggedIn()             // shared auth store (see below)
  const navigate  = useNavigate()              // from the SAME react-router-dom
  const linkStyle = (isActive) => ({ ... })    // visual: active vs idle
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: 18, ... }}>
      <strong>DevCtr KV 控制台</strong>
      <nav>
        <NavLink to="/devctr-kv" end style={linkStyle}>概览</NavLink>
        {loggedIn && (
          <>
            <NavLink to="/devctr-kv/groups">工作组</NavLink>
            <NavLink to="/devctr-kv/keys">键管理</NavLink>
            <NavLink to="/devctr-kv/user">用户</NavLink>
          </>
        )}
      </nav>
      <span style={{ flex: 1 }} />
      <button onClick={() => navigate('/audit')}>返回壳</button>
    </header>
  )
}
```

## Cross-view state — the auth store (lives outside React)

Because route switches unmount views, any in-component `useState` for shared state
(e.g. "logged in?") gets lost. devctr-kv keeps a module-closure store with a tiny pubsub
and a `useLoggedIn()` hook:

```tsx
const auth = {
  loggedIn: false,
  listeners: new Set<() => void>(),
  set(v: boolean) { this.loggedIn = v; for (const l of this.listeners) l() },
  subscribe(l: () => void) { this.listeners.add(l); return () => this.listeners.delete(l) }
}
function useLoggedIn() {
  const [v, setV] = useState(auth.loggedIn)
  useEffect(() => auth.subscribe(() => setV(auth.loggedIn)), [])
  return v
}
```

When the login form's `submit()` finishes, it calls `auth.set(true)`. The TopBar in
every view (now mounted) re-renders with the `loggedIn && (...)` block showing the
extra NavLinks. No provider / no context needed because the store is a module singleton.

## "Go to login" button — the classic gotcha

A first draft usually does `onClick={() => navigate('/user')}` and finds it dead.
The cause: the `onClick` lives on a `<button>` (not a `<NavLink>`), so the click goes
straight to the navigate function, not through an `<a href>`. With the **same**
react-router-dom instance and the same Router context, navigate works fine — but only
if the component calling it is rendered **inside** the `<BrowserRouter>`. devctr-kv's
Dashboard component is rendered under `PluginLocalRoutes` which is mounted under the
shell's `<BrowserRouter>`, so the call should work.

If the click still appears dead:
- Confirm `useNavigate()` is called inside the same component tree as the button.
- Open DevTools console; if you see "useNavigate() may be used only in the context of a
  `<Router>`", the plugin blob imported its own copy of react-router-dom (the import map
  wasn't applied). Fix by ensuring `vite.config.ts` has `external: ['react-router-dom']` and
  `index.html` has the import map entry for `react-router-dom`.
- Hard-reload to force a clean plugin-half import (the cordis `halves` Map keys by runId,
  a stale blob URL won't re-execute the new half).

## Local nav links — absolute, not relative

`<NavLink to="keys">` is the most common mistake: react-router v6 resolves the link
relative to the **current match's path prefix**, which is `/devctr-kv/*` — the
resolved URL would be `/devctr-kv/keys` (works), but only because the second
segment coincidentally matches. If you write `<NavLink to="group/123">` expecting it
to become `/devctr-kv/group/123`, you'll get `/devctr-kv/group/123` *only* if your
plugin defined a `/group/:id` route — otherwise it falls through to the `*` fallback.

**Always use absolute prefixed links in fullscreen plugins:**

```tsx
// YES:
<NavLink to="/devctr-kv/keys">键管理</NavLink>
<NavLink to="/devctr-kv" end>概览</NavLink>
<button onClick={() => navigate('/devctr-kv/user')}>去登录</button>
<button onClick={() => navigate('/audit')}>返回壳</button>

// NO:
<NavLink to="keys">                 // works, but fragile — relies on current match
<NavLink to={`/${slug}`}>          // absolute-but-relative-to-app-root, breaks inside the prefix
```

## Key paths cheat sheet

| You want | Code |
|---|---|
| Sub-route NavLink | `<NavLink to="/<prefix>/<sub>"`>` |
| Sub-route programmatic | `const navigate = useNavigate(); navigate('/<prefix>/<sub>')` |
| Bare prefix (e.g. `/devctr-kv`) | `routes: [{ path: '/', Component: X }]` → maps to `<Route path="">` |
| Unknown sub-path fallback | `Component: Y` on the top-level registration → `path="*"` |
| Exit to shell | `navigate('/audit')` (or any shell route) |
| Share state across views | module-closure store + `useEffect` subscriber (or a cordis service) |
| Confirm Router context is alive | open DevTools console; if `useNavigate()` is `undefined`, plugin half imported its own copy of `react-router-dom` — fix the import map / vite external |

## Adding a new sub-route (the 30-second change)

1. `manifest.json`: append to `halves.browser.pages[0].routes`: `[{ "path": "/<new>" }]`
2. `browser.tsx`: define `const NewView = () => (<><TopBar /><div className="page">…</div></>)`
3. Add `{ path: '/<new>', Component: NewView }` to the `routes` array in `ctx.pages.register`
4. Add a `<NavLink to="/<prefix>/<new>">` in `TopBar` (or wherever your nav lives)
5. Rebuild zip, upload, hard-reload the page

No shell changes. No router changes. The plugin fully owns the experience.

