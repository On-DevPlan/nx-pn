# The second plugin: `plugins/echo/`

A user-driven API request tester. Unlike `example-api` (which fires one fixed GET
on activation), echo provides a form where the user picks the HTTP method, types
a URL, headers, and body, and the form dispatches the request through the
unified `auditClient`.

## What makes it different from example-api

| Aspect | example-api | echo |
|---|---|---|
| Trigger | Activation-time (hello-call) | User-driven (form submit) |
| HTTP methods | GET only | GET, POST, PUT, PATCH, DELETE |
| Page complexity | Counter + nav links | Form with method/url/headers/body inputs |
| Replay story | Hello-call is replayable | Every form submission is replayable |
| Demonstrates | Shared React invariant | All HTTP verbs + per-verb auditClient dispatch |

## File structure

```
plugins/echo/
├── package.json           # npm-style: api-audit.manifest, api-audit.browser
├── tsconfig.json          # extends ../../tsconfig.base.json
├── manifest.json          # zip-style: schemaVersion, id, halves, pages
├── host.ts                # registers 'echo/ping' tool event + hello-call
├── browser.tsx            # EchoPage component (useState, useNavigate, closure-captured ctx)
├── scripts/build-zip.mjs  # esbuild host+browser → dist/echo.zip
├── README.md              # one-paragraph what/how
└── dist/                  # build output (echo.zip, host.js, browser.js, manifest.json)
```

## Manifest (`manifest.json`)

```json
{
  "schemaVersion": 1,
  "id": "echo",
  "version": "1.0.0",
  "title": "Echo 测试插件",
  "halves": {
    "host": { "entry": "host.js" },
    "browser": {
      "entry": "browser.js",
      "pages": [{ "path": "/echo", "title": "Echo 测试" }]
    }
  }
}
```

## Host half (`host.ts`)

Registers a tool endpoint `echo/ping` on the cordis event bus. The browser page
emits this event via `ctx.emit('echo/ping', { url })`, and the host handler
converts it into one audited GET. Also fires one hello-call at activation.

```ts
const plugin = function plugin(ctx, config) {
  const id = config?.name ?? 'echo'
  ctx.logger.info(`[echo] host half active (plugin ${id})`)

  ctx.on('echo/ping', (payload) => {
    const url = pickUrl(payload) ?? 'https://httpbin.org/get'
    return ctx.auditClient.get(url, { headers: { 'user-agent': 'api-audit-echo/1.0.0' } })
      .then(res => ctx.logger.info(`GET ${url} → ${res.status}`))
      .catch(err => ctx.logger.warn(`GET ${url} failed: ${err.message}`))
  })

  void ctx.auditClient.get('https://httpbin.org/get').catch(() => {})
}
;(plugin as PluginFn).inject = ['auditClient']
export default plugin
```

## Browser half (`browser.tsx`)

The `EchoPage` component is **defined inside the plugin function** so it closes
over `ctx`. No window hacks or context prop-drilling. The form dispatches based
on the selected HTTP method using the per-verb auditClient methods (get/post/
put/patch/delete).

```tsx
const browserHalf = function browserHalf(ctx, config) {
  const id = config?.name ?? 'echo'

  const EchoPage = () => {
    const [method, setMethod] = useState('GET')
    const [url, setUrl] = useState('https://httpbin.org/get')
    // ... headers, body, result, busy state ...
    const onSend = async () => {
      if (method === 'GET') res = await ctx.auditClient.get(url, config)
      else if (method === 'POST') res = await ctx.auditClient.post(url, body, config)
      // ... put, patch, delete ...
    }
    return <div>...form with select/input/textarea/button...</div>
  }

  ctx.pages.register({
    pluginId: id,
    path: '/echo',
    title: 'Echo 测试',
    order: 210,
    Component: EchoPage,
  })
}
;(browserHalf as ...).inject = ['pages', 'auditClient']
export default browserHalf
```

## Build

```bash
cd plugins/echo
node scripts/build-zip.mjs    # → dist/echo.zip (6840 bytes)
```

The build script:
1. Compiles `host.ts` → `dist/host.js` (esbuild, platform=node, external=['cordis'])
2. Compiles `browser.tsx` → `dist/browser.js` (esbuild, platform=browser, jsx=automatic,
   external=['react','react-dom','react/jsx-runtime','react-dom/client','react-router-dom','cordis'])
3. **Asserts** the compiled `browser.js` keeps `react` and `react-router-dom` as bare imports
   (regex check — would throw if esbuild bundled them)
4. Copies `manifest.json` → `dist/manifest.json`
5. Writes a STORED zip (no compression) → `dist/echo.zip`

## Live smoke

**Upload:**
```bash
curl -F "zip=@plugins/echo/dist/echo.zip" http://localhost:4560/api/plugins
# → { "ok": true, "data": { "id": "echo", "pluginRunId": "run-11", ... } }
```

**Sidebar** (browser, after page load):
```
插件页面
  示例 API
  Echo 测试        ← new link
```

**`/echo` page** renders the form with method dropdown, URL input, headers textarea,
body textarea, and a 发送 button.

**Audit log** (`/audit`):
```
time                initiator  method  URL                          status
2026/9/3 21:45:20   echo       GET     https://httpbin.org/get      200
```

Every echo request appears in the audit log with `initiator: "echo"`. Each record
is replayable from `/replay` (editable method/URL/headers/body, then re-run).

## Replay story

1. User sends a request from `/echo` → AuditRecord created with `initiator: "echo"`
2. User goes to `/replay`, selects the record from the dropdown
3. User edits the request (change method to POST, add body, etc.)
4. User confirms → new auditClient call with `initiator: "replay:<recordId>"`
5. New AuditRecord created with `replayOf: <originalId>`
6. Side-by-side comparison shown on the replay page

## npm install path (alternative)

The same plugin can be distributed as an npm package. Add to `package.json`:
```json
{
  "name": "echo",
  "version": "1.0.0",
  "type": "module",
  "main": "./host.js",
  "api-audit": {
    "manifest": { "id": "echo", "version": "1.0.0", "title": "Echo 测试插件" },
    "browser": "./browser.js"
  }
}
```

Install: `npx @flowot/nx-pn add echo` (or `add file:./plugins/echo` for local).
