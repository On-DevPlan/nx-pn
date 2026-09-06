# Development within the repo

## Build & test commands

```bash
# Build everything
pnpm -r build

# Run all tests
pnpm test

# Run tests for one package
pnpm --filter @flowot/nx-pn-host test
pnpm --filter @flowot/nx-pn-client test
pnpm --filter @flowot/nx-pn-core test

# Build one package
pnpm --filter @flowot/nx-pn-host build

# Lint
pnpm exec nx run-many -t lint

# Nx run-many with memory limit
pnpm exec nx run-many -t build --parallel=1
```

If OOM: add `--parallel=1` to nx run-many.

## Code conventions

### `verbatimModuleSyntax: true` → use `export type`

The root `tsconfig.base.json` sets `verbatimModuleSyntax: true`. Type-only exports
**must** use `export type`:

```ts
// ✅ correct
export type { AuditClient, AuditResponse } from './audit-client.js'

// ❌ wrong — TS error under verbatimModuleSyntax
export { AuditClient, AuditResponse } from './audit-client.js'
```

### cordis services MUST be prototype-method

cordis's caller-tracker binds `this.ctx` to the calling fiber only for prototype
methods, not arrow-class-field methods. Always use:

```ts
export class AuditClientService extends CordisService {
  static readonly service = 'auditClient'
  declare get: (url: string) => Promise<AuditResponse>
  declare post: (url: string, body?: unknown) => Promise<AuditResponse>

  constructor(ctx: Context) { super(ctx, 'auditClient') }
}

const proto = AuditClientService.prototype as unknown as Record<string, unknown>
proto.get = function(this: unknown, url: string) {
  const initiator = callerInitiator(this)
  return requireDeps().client.get(url, initiator ? { ...config, initiator } : config)
}
```

### `ctx` typings live with the domain file

`index.ts` is a pure re-export surface. Types and service classes live in their
domain files (`audit-client.ts`, `pages-service.ts`, etc.) and are re-exported.

## Test conventions

- **vitest 2.x** for all packages
- `passWithNoTests: true` in `vitest.config.ts` — vitest 2.x exits 1 when a package
  has no test files
- ESM imports use **`.js` extension** (even for `.ts` source — NodeNext resolution)
- Test files live in `__tests__/` subdirectories

## TypeScript gotchas

### composite + JSON requires `**/*.json` in include

If a package uses `composite: true`, the `tsconfig.json` `include` must include JSON
files: `"include": ["src/**/*.ts", "**/*.json"]`. Without this, `tsc -b` fails on
`resolveJsonModule`.

### tsconfig.base.json settings

```jsonc
{
  "lib": ["ES2023", "DOM"],
  "verbatimModuleSyntax": true,
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "isolatedModules": true
}
```

## Running the host

```bash
node apps/cli/bin/nx-pn.mjs --port 4560 --no-open
```

- Data dir defaults to `~/.api-audit/`
- `--no-open` prevents auto-launching the browser (useful for CI / scripted runs)

### Kill the host on Windows

```bash
powershell -Command "Get-NetTCPConnection -LocalPort 4560 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id \$_ -Force }"
```

## Common pitfalls

### cordis d.ts invisible under NodeNext + verbatimModuleSyntax

cordis's `d.ts` files aren't consumable directly. Use the **shim pattern**:
`packages/host/src/cordis/cordis-shim.ts` + `minimal-types.ts`. Copy from the
host package if you need it in another package.

### vitest 2.x exits 1 on no tests

Add `passWithNoTests: true` to `vitest.config.ts`. This is a vitest 2.x behavior
change.

### esbuild `--watch` won't re-emit dist

If the consumer's `outDir` isn't pinned, esbuild's watch mode silently fails to
re-emit. Always set `outdir` or `outfile` explicitly.

### Windows 8.3 short-name temp paths

The Windows 8.3 short name (e.g. `C:\Users\MINISF~1`) breaks vite/vitest's ESM loader
for dynamic `import()` of files under that directory. Always `realpath()` first:

```ts
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
const osTmp = await realpath(tmpdir())
```

### Plugin source compiled without `external: ['cordis']`

If a plugin's `host.ts` is compiled without `external: ['cordis']`, esbuild bundles
cordis into the output, breaking the link to the host's cordis instance. Always pass
`external: ['cordis']` in the esbuild options for host halves.

### Git Bash `/tmp/` paths break npm `file:` specs

`mktemp -d` in Git Bash yields `/tmp/...`, which Node/npm resolve as `C:\tmp\...`
(ENOENT on package.json). Use `cygpath -w`-equivalent real Windows paths
(e.g. `$LOCALAPPDATA/Temp/...`) for `file:` specs and `--data-dir`.

### Init template ↔ scaffolded-fileList lockstep

`apps/cli/src/init.ts` `scaffoldPlugin` iterates a hard-coded `fileList`. Adding
a template file to `apps/cli/templates/plugin-workspace/` without adding it to
`fileList` (and to `init.test.ts`'s file-count assertion) silently drops it from
every scaffolded plugin. Keep all three in sync.

## Verification

```bash
pnpm check:spec    # runs tools/check-spec.sh — enforces spec compliance rules
```

This catches issues like arrow-class-field methods in cordis services, missing
externals in plugin builds, and other spec violations.
