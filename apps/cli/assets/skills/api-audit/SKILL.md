---
name: api-audit
description: Use when developing, testing, building, or publishing an nx-pn (@flowot/nx-pn) plugin — host half (ctx.on tool endpoints, pluginStorage, auditClient), browser half (ctx.pages.register, ctx.hostCall.hostCall), the dev loop (npm run dev / hot upload), and the zip/npm install paths.
---

# nx-pn plugin development

nx-pn is a cordis plugin platform: the browser half renders a page in the
nx-pn web shell, the host half runs in the Node host, and every network call
goes through the host's audited `ctx.auditClient`. Plugins live in a
workspace (scaffold with `npx @flowot/nx-pn init <name>`) holding one or more
plugins under `plugins/<id>/`.

## Dev loop

```bash
npx @flowot/nx-pn init <name>   # scaffold a plugin workspace
cd <name> && npm install
npm run dev            # probes/spawns a host on :4560, uploads every
                       # plugins/<id>/, then watches plugins/ — change →
                       # rebuild → re-upload (hot-replace). Ctrl-C to stop.
npm test               # node:test + tsx — runs plugins/<id>/host.test.ts
npm run typecheck      # tsc over the plugin's *.ts / *.tsx
npm run build          # → dist/<id>.zip (manifest + host.js + browser.js)
```

## Contract

### Host half — `host.ts` (Node ESM, esbuild `external: ['cordis']`)

```ts
export default async (ctx, config) => {   // config.name = manifest.id
  ctx.logger.info(`[${config?.name}] active`)
  ctx.auditClient.get(url)                 // audited HTTP, attributed to this plugin
  ctx.on('<id>/my-action', (payload) => ({ ok: true, data: {} }))  // a tool endpoint
  const t = ctx.pluginStorage.table('settings')   // per-plugin durable KV
  await t.put('key', value); t.get('key')
}
;(plugin as any).inject = ['auditClient']   // optional: delay activation until ready
```

`ctx.on('<id>/<action>', handler)` registers a **tool endpoint**; the browser half
invokes it with `ctx.hostCall.hostCall('<id>/<action>', payload)`. The handler's
return value is wrapped in `{ ok, data?, error? }`.

`ctx.pluginStorage.table(name)` is this plugin's own durable namespace (survives
stop / remove / re-install); tables carry `get` / `put` / `delete` / `keys`.

### Browser half — `browser-*.tsx` (React, shared vendor chunk)

```tsx
export default (ctx) => {
  const Page = () => {                       // define inside so it closes over ctx
    const [n, setN] = useState(0)
    return <button onClick={async () => {
      const r = await ctx.hostCall.hostCall('<id>/my-action', { n })  // → { ok, data, error }
      const a = await ctx.auditClient.get('https://...')     // proxied to host over WS
    }}>{n}</button>
  }
  ctx.pages.register({ pluginId: '<id>', path: '/<id>', title: 'Title', Component: Page })
}
;(fn as any).inject = ['pages', 'auditClient', 'hostCall']   // wait for all three services
```

**The call shape is `ctx.hostCall.hostCall(event, payload)`** — a cordis service
method, NOT `ctx.hostCall(event, payload)`. Registering without `'hostCall'`
in inject leaves the service unresolved.

`ctx.pages.register({ pluginId, path, title, order?, layout?, routes?, Component })`:
- `layout: 'shell'` (default) → flat page inside the shell's `<main>`
- `layout: 'fullscreen'` → plugin claims the whole viewport; render your own
  `<Routes>` and carry your own top bar.

**Required externals** — the build keeps `cordis`, `react`, `react/jsx-runtime`,
`react-dom`, `react-dom/client`, `react-router-dom` **external** so the shell's
import map supplies one shared React. `scripts/build.mjs` asserts this on the
compiled output; breaking it silently doubles React.

## Build → install → publish

```bash
npm run build                                       # → dist/<id>.zip (manifest + host.js + browser.js)
curl -F zip=@dist/<id>.zip http://localhost:4560/api/plugins   # hot-add to a running host (live)
npx @flowot/nx-pn add file:.                        # ledger install (npm path; takes effect on next host start)
npm publish                                         # consumers: npx @flowot/nx-pn add <pkg>
```

Re-installing the same `id` (zip upload or ledger) **upserts**: the old run is
disposed and the browser half is re-pushed to every connected shell — at most
one active run per `manifest.id` at any instant.

## Pitfalls

- Views must **close over `ctx`** — the shell registers components without
  props, so `props.ctx` is undefined at render time.
- Plugin attribution comes from the calling fiber, so `ctx.auditClient` calls
  land on `/audit` with `initiator = <manifest.id>`; a `ctx.on` tool endpoint
  invoked from the browser is attributed the same way.
- Don't collapse the browser half to a single fixed filename across layouts —
  the build discovers it by the `browser*.tsx` glob.
