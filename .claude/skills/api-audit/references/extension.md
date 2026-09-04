# Extending the repo

## Adding a new package

```bash
mkdir packages/my-package/src
```

Create these files:

**`packages/my-package/package.json`:**
```json
{
  "name": "@scope/my-audit-plugin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  }
}
```

**`packages/my-package/tsconfig.json`:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts", "**/*.json"],
  "references": [{ "path": "../core" }]
}
```

**`packages/my-package/vitest.config.ts`:**
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { passWithNoTests: true },
})
```

The workspace glob `packages/*` in `pnpm-workspace.yaml` already covers it. Run
`pnpm install` to link it.

## Adding a new cordis service in host

1. Create `packages/host/src/cordis/my-service.ts`
2. Extend `CordisService` with **prototype methods** (not arrow fields)
3. Declare the service name: `static readonly service = 'myService'`
4. Register in `host-context.ts`:
   ```ts
   export class MyService extends CordisService {
     static readonly service = 'myService'
     declare doThing: () => Promise<void>
     constructor(ctx: Context) { super(ctx, 'myService') }
   }
   const myProto = MyService.prototype as unknown as Record<string, unknown>
   myProto.doThing = function() { /* ... */ }
   ```
5. Add to `installCoreServices`: `ctx.registry.plugin(MyService, {})`
6. Add the deps to `HostDeps` and `setHostDeps` in `host-context.ts`

## Adding a new REST route

1. Create `packages/host/src/server/my-route.ts`
2. Export an async handler: `export async function handleMyRoute(deps, req, res, urlPath): Promise<void>`
3. Register in `http-server.ts` route table (the `tryHandle` switch or similar)
4. Use `sendJson(res, status, payload)` or `sendText(res, status, text)` from `http-utils.ts`

## Adding a new WS RPC op

1. Extend the `RpcOp` union in `packages/client/src/rpc/protocol.ts`
2. Add the dispatch case in `rpc-bridge.ts` (host side)
3. Add the handler in `packages/client/src/index.ts` `routeFrame()` (browser side)
4. Add a test for the round-trip

## Adding a new core page

1. Create `apps/web/src/pages/MyPage.tsx`
2. Add a `NavLink` in `apps/web/src/App.tsx`:
   ```tsx
   <NavLink to="/my-page" className="nav-item">My Page</NavLink>
   ```
3. Add a `Route` in the `<Routes>` block:
   ```tsx
   <Route path="/my-page" element={<MyPage runtime={runtime} />} />
   ```
4. If the page needs data, use the `BrowserRuntimeHandle` (WS) or `fetchAudit`/`fetchPluginList` from `@flowot/nx-pn-client`

## Extending the plugin manifest schema

1. Update `packages/core/src/schema/manifest.schema.json` with the new field
2. Add the corresponding field to the `Manifest` type in `packages/core/src/manifest.ts`
3. If the field is a nested object, update `HalfEntry` or `PageDeclaration` too
4. Re-run `pnpm check:spec` — `validateManifest` will reject non-conforming zips
5. Add a test in `packages/core/src/__tests__/manifest.test.ts`

## Building & testing after changes

```bash
pnpm -r build              # build all packages
pnpm -r test               # run all tests
pnpm exec nx run-many -t lint
```

## Don't regress these

- **The cordis shim** (`packages/host/src/cordis/cordis-shim.ts` + `minimal-types.ts`)
  — it's the only way cordis's d.ts works under NodeNext + verbatimModuleSyntax
- **The WS protocol frame** — adding an op requires updating both bridge.ts (host)
  and routeFrame() (client)
- **The 16 MB frame cap** (`MAX_FRAME_BYTES` in `packages/client/src/rpc/protocol.ts`)
  — larger frames must be chunked or sent as multipart
- **The 30 s request timeout** — matches the auditClient default; change both
  together if you need to
