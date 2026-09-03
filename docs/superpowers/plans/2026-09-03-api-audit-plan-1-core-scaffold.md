# api-audit Plan 1: Monorepo Scaffold + packages/core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Nx + pnpm monorepo at `D:/code/a_js/proj/nx-pn` and the zero-dependency `packages/core` library that defines the AuditClient/Middleware/Manifest contracts with full unit tests.

**Architecture:** Workspace uses `pnpm` workspaces (canonical store, fast installs) orchestrated by Nx (task graph with `dependsOn: ['^build']`, cache, run-many). `packages/core` is a pure TypeScript library with **no cordis dependency** — it exports only types, constants, and three runtime helpers (`compose`, `validateManifest`, `redactCredentials`).

**Tech Stack:** pnpm 9.15, Nx 19.8, TypeScript 5.6, Vitest 2.1, ajv 8.17 (JSON Schema validation for manifest).

**Spec:** [`docs/superpowers/specs/2026-09-03-api-audit-design.md`](../specs/2026-09-03-api-audit-design.md) (commit `2520a1b`).

**Upstream plans:** None (first plan).
**Downstream plans:** Plan 2 (`packages/host`) depends on this plan's `packages/core` types and `validateManifest`/`redactCredentials` exports.

---

## File Structure (this plan)

```
nx-pn/
├── package.json                          # CREATE — root workspace
├── pnpm-workspace.yaml                   # CREATE — workspace globs
├── nx.json                               # CREATE — task pipeline + cache
├── tsconfig.base.json                    # CREATE — strict, ESM, NodeNext
├── .gitignore                            # CREATE — node_modules/dist/lib/.nx/coverage
├── .npmrc                                # CREATE — engine-strict, hoist minimal
└── packages/
    └── core/
        ├── package.json                  # CREATE — name @api-audit/core, ESM, exports
        ├── tsconfig.json                 # CREATE — composite, extends base
        ├── src/
        │   ├── index.ts                  # CREATE — re-exports public API
        │   ├── audit-client.ts           # CREATE — AuditClient/RequestConfig/AuditResponse + MAX_BODY_BYTES
        │   ├── middleware.ts             # CREATE — Middleware/MiddlewareContext/Next types + compose()
        │   ├── manifest.ts               # CREATE — Manifest/HalfEntry/PageDeclaration types + MANIFEST_VERSION
        │   ├── manifest-schema.ts        # CREATE — JSON Schema (for ajv) + validateManifest()
        │   ├── credentials.ts            # CREATE — redactCredentials() + SENSITIVE_HEADER_NAMES
        │   ├── schema/
        │   │   └── manifest.schema.json  # CREATE — ajv schema source
        │   └── __tests__/
        │       ├── audit-client.test.ts  # CREATE — constant + interface smoke test
        │       ├── middleware.test.ts    # CREATE — compose() ordering, error propagation, async
        │       ├── manifest.test.ts      # CREATE — validateManifest happy + every rejection path
        │       └── credentials.test.ts   # CREATE — redactCredentials on common header sets
        └── vitest.config.ts              # CREATE — minimal config
```

Total new files: ~18. Total new dependencies (root): 1 (ajv). Total new dependencies (packages/core): 1 (vitest + ajv as dev).

---

## Global Constraints

These are absolute requirements copied verbatim from the spec. Every task implicitly enforces them.

- **`MAX_BODY_BYTES = 1 * 1024 * 1024`** (1 MiB) — exported from `packages/core/src/audit-client.ts` as `MAX_BODY_BYTES`.
- **`MAX_ZIP_BYTES = 4 * 1024 * 1024`** (4 MB) — exported from `packages/core/src/manifest.ts` as `MAX_ZIP_BYTES` (per spec §3.4).
- **`MANIFEST_VERSION = 1`** — exported from `packages/core/src/manifest.ts`.
- Plugin id format: regex `/^[a-z0-9-]+$/`.
- Plugin version format: regex `^\d+\.\d+\.\d+(-[\w.]+)?$`.
- Page path format: must start with `/`.
- TypeScript: `strict: true`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2023`.
- Nx `targetDefaults.build.dependsOn: ["^build"]` — packages must build in dependency order.
- `packages/core`: **zero** cordis Context augmentation (`declare module 'cordis'` must never appear here).
- Node engine floor: `>=22.7.0` (ESM default module-syntax detection).
- pnpm engine floor: `>=9.0.0`.
- No git worktree in this plan — workspace was just initialized in the main directory.

---

## Task 1: Root Workspace Configuration

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `nx.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.npmrc`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a workspace whose `pnpm install` succeeds and whose `pnpm exec nx --version` returns 19.8.x.

- [ ] **Step 1: Write `package.json` at the workspace root**

```json
{
  "name": "api-audit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": {
    "node": ">=22.7.0",
    "pnpm": ">=9.0.0"
  },
  "scripts": {
    "build": "pnpm exec nx run-many -t build",
    "test": "pnpm exec nx run-many -t test",
    "lint": "pnpm exec nx run-many -t lint"
  },
  "devDependencies": {
    "nx": "19.8.6",
    "typescript": "5.6.3"
  }
}
```

- [ ] **Step 2: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'plugins/*'
```

- [ ] **Step 3: Write `nx.json`**

```json
{
  "$schema": "./node_modules/nx/schemas/nx-schema.json",
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "production": [
      "default",
      "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)",
      "!{projectRoot}/tsconfig.spec.json",
      "!{projectRoot}/vitest.config.*"
    ],
    "sharedGlobals": ["{workspaceRoot}/tsconfig.base.json"]
  },
  "targetDefaults": {
    "build": {
      "cache": true,
      "dependsOn": ["^build"],
      "inputs": ["production", "^production"]
    },
    "test": {
      "cache": true,
      "inputs": ["default", "^production"]
    },
    "lint": {
      "cache": true,
      "inputs": ["default"]
    }
  },
  "defaultBase": "master"
}
```

- [ ] **Step 4: Write `tsconfig.base.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
lib/
coverage/
.nx/cache
.nx/workspace-data
*.log
.DS_Store
Thumbs.db
.env
.env.local
data-dir/
```

- [ ] **Step 6: Write `.npmrc`**

```
engine-strict=true
auto-install-peers=true
strict-peer-dependencies=false
```

- [ ] **Step 7: Install dependencies**

Run: `pnpm install`
Expected: lockfile created, `node_modules` populated, no errors. `pnpm exec nx --version` returns `19.8.6`.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml nx.json tsconfig.base.json .gitignore .npmrc pnpm-lock.yaml
git commit -m "chore: initialize Nx + pnpm monorepo (api-audit)"
```

---

## Task 2: packages/core Scaffold

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/project.json` (Nx project descriptor)

**Interfaces:**
- Consumes: root `tsconfig.base.json`.
- Produces: a buildable/testable `@api-audit/core` package that exposes `src/index.ts`; `pnpm --filter @api-audit/core build` and `pnpm --filter @api-audit/core test` work.

- [ ] **Step 1: Write `packages/core/package.json`**

```json
{
  "name": "@api-audit/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["lib", "src/schema"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "ajv": "8.17.1"
  },
  "devDependencies": {
    "vitest": "2.1.5",
    "typescript": "5.6.3"
  }
}
```

- [ ] **Step 2: Write `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./lib",
    "rootDir": "./src",
    "tsBuildInfoFile": "./lib/tsconfig.tsbuildinfo",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**", "src/**/*.test.ts"]
}
```

- [ ] **Step 3: Write `packages/core/project.json`**

```json
{
  "name": "core",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "packages/core/src",
  "projectType": "library",
  "targets": {
    "build": {
      "executor": "nx:run-commands",
      "options": {
        "command": "tsc -b",
        "cwd": "packages/core"
      },
      "outputs": [
        "{projectRoot}/lib",
        "{projectRoot}/lib/tsconfig.tsbuildinfo"
      ]
    },
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "vitest run",
        "cwd": "packages/core"
      },
      "outputs": ["{projectRoot}/coverage"]
    },
    "lint": {
      "executor": "nx:run-commands",
      "options": {
        "command": "tsc --noEmit",
        "cwd": "packages/core"
      }
    }
  }
}
```

- [ ] **Step 4: Write `packages/core/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
})
```

- [ ] **Step 5: Write `packages/core/src/index.ts` placeholder**

```ts
// Public API surface — populated by Tasks 3-6.
export const CORE_API_VERSION = '0.0.0'
```

- [ ] **Step 6: Install the package**

Run: `pnpm install`
Expected: `ajv` and `vitest` resolve under `packages/core/node_modules` (or via hoisting). No peer warnings.

- [ ] **Step 7: Verify build + test run (with placeholder)**

Run: `pnpm --filter @api-audit/core build && pnpm --filter @api-audit/core test`
Expected: `tsc -b` produces `packages/core/lib/index.js` + `.d.ts`; vitest reports "No test files found, exiting with code 0".

- [ ] **Step 8: Commit**

```bash
git add packages/core/package.json packages/core/tsconfig.json packages/core/project.json packages/core/vitest.config.ts packages/core/src/index.ts pnpm-lock.yaml
git commit -m "feat(core): scaffold @api-audit/core package (placeholder)"
```

---

## Task 3: AuditClient + AuditResponse + Constants (Types Only)

**Files:**
- Create: `packages/core/src/audit-client.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/audit-client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AuditClient`, `RequestConfig`, `AuditResponse`, `MAX_BODY_BYTES` exports.

- [ ] **Step 1: Write the failing test `audit-client.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { MAX_BODY_BYTES } from '../audit-client.js'

describe('audit-client constants', () => {
  it('exports MAX_BODY_BYTES = 1 MiB', () => {
    expect(MAX_BODY_BYTES).toBe(1024 * 1024)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @api-audit/core test`
Expected: FAIL with "Cannot find module '../audit-client.js'".

- [ ] **Step 3: Implement `audit-client.ts`**

```ts
/**
 * Maximum body bytes (after decompression) before truncation kicks in.
 * Spec §3.1: 1 MiB.
 */
export const MAX_BODY_BYTES = 1 * 1024 * 1024

export interface RequestConfig {
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Default 30_000; matches WS RPC default timeout (spec §3.1 / §4.5.2). */
  timeoutMs?: number
}

export interface AuditResponse {
  status: number
  statusText: string
  /** Decompressed headers (undici transparently decompresses; not wire headers). */
  headers: Record<string, string>
  /** Decompressed body byte count. */
  bytes: number
  truncated: boolean
  /**
   * Body as text. JSON bodies are JSON.parse → JSON.stringify so the diff view
   * is stable; otherwise utf-8 string. When `truncated`, only the first 4 KB.
   */
  bodyText: string
  /** Structured view when body parses as JSON AND not truncated. */
  bodyJson?: unknown
}

export interface AuditClient {
  get(url: string, config?: RequestConfig): Promise<AuditResponse>
  post(url: string, body?: BodyInit | unknown, config?: RequestConfig): Promise<AuditResponse>
  put(url: string, body?: BodyInit | unknown, config?: RequestConfig): Promise<AuditResponse>
  patch(url: string, body?: BodyInit | unknown, config?: RequestConfig): Promise<AuditResponse>
  delete(url: string, config?: RequestConfig): Promise<AuditResponse>
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Replace the file with:

```ts
export const CORE_API_VERSION = '0.0.0'

export {
  AuditClient,
  AuditResponse,
  RequestConfig,
  MAX_BODY_BYTES,
} from './audit-client.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @api-audit/core test`
Expected: PASS (1 test).

- [ ] **Step 6: Verify build still succeeds**

Run: `pnpm --filter @api-audit/core build`
Expected: tsc emits `lib/audit-client.js` + `lib/audit-client.d.ts`. No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/audit-client.ts packages/core/src/__tests__/audit-client.test.ts packages/core/src/index.ts
git commit -m "feat(core): AuditClient interface + MAX_BODY_BYTES"
```

---

## Task 4: Middleware Types + compose()

**Files:**
- Create: `packages/core/src/middleware.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/middleware.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Middleware`, `MiddlewareContext`, `Next` types and `compose(middlewares, terminal)` helper.

The compose helper builds the standard onion: given `mw1, mw2, mw3`, it produces a function that calls `mw1(mw2(mw3(terminal))(ctx))(ctx)`. Each middleware can short-circuit by not calling `next`.

- [ ] **Step 1: Write the failing test `middleware.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { compose, type Middleware } from '../middleware.js'

const noop = async () => undefined

describe('compose()', () => {
  it('returns a function that returns the terminal result when no middleware exists', async () => {
    const terminal = () => Promise.resolve('terminal-value')
    const chain = compose<undefined, string>([], terminal)
    expect(await chain(noop())).toBe('terminal-value')
  })

  it('runs middlewares in declared order around terminal', async () => {
    const calls: string[] = []
    const terminal = () => {
      calls.push('terminal')
      return Promise.resolve()
    }
    const a: Middleware<undefined, void> = async (_ctx, next) => {
      calls.push('a-pre')
      const r = await next()
      calls.push('a-post')
      return r
    }
    const b: Middleware<undefined, void> = async (_ctx, next) => {
      calls.push('b-pre')
      const r = await next()
      calls.push('b-post')
      return r
    }
    const chain = compose<undefined, void>([a, b], terminal)
    await chain(noop())
    expect(calls).toEqual(['a-pre', 'b-pre', 'terminal', 'b-post', 'a-post'])
  })

  it('lets a middleware short-circuit by skipping next()', async () => {
    const calls: string[] = []
    const terminal = () => {
      calls.push('terminal')
      return Promise.resolve('terminal-value')
    }
    const a: Middleware<undefined, string> = async (_ctx, _next) => {
      calls.push('a-pre')
      return 'short-circuit'
    }
    const b: Middleware<undefined, string> = async (_ctx, next) => {
      calls.push('b-pre')
      return next()
    }
    const chain = compose<undefined, string>([a, b], terminal)
    expect(await chain(noop())).toBe('short-circuit')
    expect(calls).toEqual(['a-pre']) // b never runs, terminal never runs
  })

  it('propagates errors thrown by inner middleware / terminal', async () => {
    const terminal = () => Promise.reject(new Error('boom'))
    const a: Middleware<undefined, void> = async (_ctx, next) => {
      try {
        await next()
      } catch (err) {
        // re-throw after wrapping
        throw new Error(`wrapped: ${(err as Error).message}`)
      }
    }
    const chain = compose<undefined, void>([a], terminal)
    await expect(chain(noop())).rejects.toThrow('wrapped: boom')
  })

  it('handles async next() correctly (waits for inner to settle)', async () => {
    let innerSettled = false
    const terminal = async () => {
      await new Promise((r) => setTimeout(r, 10))
      innerSettled = true
      return 'done'
    }
    const a: Middleware<undefined, string> = async (_ctx, next) => {
      const r = await next()
      expect(innerSettled).toBe(true)
      return r
    }
    const chain = compose<undefined, string>([a], terminal)
    expect(await chain(noop())).toBe('done')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @api-audit/core test`
Expected: FAIL with "Cannot find module '../middleware.js'".

- [ ] **Step 3: Implement `middleware.ts`**

```ts
export type Next = () => Promise<unknown>

/**
 * A middleware sees the request context, calls `next()` to continue down
 * the chain, and may modify the response on the way back. Use the same
 * type used by the spec §3.2 audit middleware (which fills `initiator`,
 * `headers`, `body` and writes the audit record on the way back).
 */
export interface Middleware<TContext = unknown, TResponse = unknown> {
  (ctx: TContext, next: Next): Promise<TResponse>
}

/**
 * Compose an array of middlewares into a single function. The returned
 * function takes the initial context and runs the chain, ending with the
 * terminal handler. Order is left-to-right (first middleware is outermost).
 *
 *   compose([a, b, c], terminal) ≡ a(ctx) { return b(ctx) { return c(ctx) { return terminal() } } }
 */
export function compose<TContext, TResponse>(
  middlewares: ReadonlyArray<Middleware<TContext, TResponse>>,
  terminal: (ctx: TContext) => Promise<TResponse>,
): (ctx: TContext) => Promise<TResponse> {
  return (ctx) => {
    let index = -1
    const dispatch = (i: number): Promise<TResponse> => {
      if (i <= index) {
        return Promise.reject(new Error('next() called multiple times'))
      }
      index = i
      if (i === middlewares.length) {
        return terminal(ctx)
      }
      const mw = middlewares[i]!
      return Promise.resolve(mw(ctx, () => dispatch(i + 1)))
    }
    return dispatch(0)
  }
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Append to the existing exports:

```ts
export type { Middleware, MiddlewareContext, Next } from './middleware.js'
export { compose } from './middleware.js'

import type { Next } from './middleware.js'

export interface MiddlewareContext {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  /** Auto-injected initiator (pluginId or 'replay:<recordId>' or 'core'). */
  initiator: string
  headers: Record<string, string>
  /** Serialized body (post-credential-redaction). */
  body?: string
  /** Associated pluginRunId for browser-half-originated calls. */
  pluginRunId?: string
  /** Pass-through for downstream middlewares (e.g., audit timestamp). */
  startTs?: number
}

/** Re-export so Next stays adjacent to Middleware. */
export type { Next as _Next } from './middleware.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @api-audit/core test`
Expected: PASS (6 tests total: 1 from Task 3 + 5 from Task 4).

- [ ] **Step 6: Verify build**

Run: `pnpm --filter @api-audit/core build`
Expected: tsc emits `lib/middleware.js` + `lib/middleware.d.ts`. No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/middleware.ts packages/core/src/index.ts packages/core/src/__tests__/middleware.test.ts
git commit -m "feat(core): Middleware types + compose() helper"
```

---

## Task 5: Manifest Types + JSON Schema + validateManifest()

**Files:**
- Create: `packages/core/src/schema/manifest.schema.json`
- Create: `packages/core/src/manifest-schema.ts`
- Create: `packages/core/src/manifest.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/manifest.test.ts`

**Interfaces:**
- Consumes: `ajv` (already installed in Task 2).
- Produces: `Manifest`, `HalfEntry`, `PageDeclaration` types, `MANIFEST_VERSION`, `MAX_ZIP_BYTES`, `validateManifest(json): Manifest` (throws on invalid).

- [ ] **Step 1: Write the JSON Schema file `manifest.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://api-audit.local/schemas/manifest.v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "id", "version", "title", "halves"],
  "properties": {
    "schemaVersion": {
      "type": "integer",
      "const": 1
    },
    "id": {
      "type": "string",
      "pattern": "^[a-z0-9-]+$",
      "minLength": 1,
      "maxLength": 64
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(-[\\w.]+)?$"
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "halves": {
      "type": "object",
      "additionalProperties": false,
      "minProperties": 1,
      "properties": {
        "host": { "$ref": "#/definitions/halfEntry" },
        "browser": { "$ref": "#/definitions/halfEntry" }
      }
    },
    "inject": {
      "type": "array",
      "items": { "type": "string", "minLength": 1, "maxLength": 64 },
      "uniqueItems": true
    }
  },
  "definitions": {
    "halfEntry": {
      "type": "object",
      "additionalProperties": false,
      "required": ["entry"],
      "properties": {
        "entry": {
          "type": "string",
          "pattern": "^[a-zA-Z0-9_\\-./]+\\.(js|jsx|ts|tsx)$"
        },
        "pages": {
          "type": "array",
          "items": { "$ref": "#/definitions/pageDeclaration" },
          "uniqueItems": true
        },
        "inject": {
          "type": "array",
          "items": { "type": "string" },
          "uniqueItems": true
        }
      }
    },
    "pageDeclaration": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "title"],
      "properties": {
        "path": {
          "type": "string",
          "pattern": "^/[a-zA-Z0-9_\\-/.:]*$",
          "minLength": 1,
          "maxLength": 256
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "icon": { "type": "string", "maxLength": 64 },
        "order": { "type": "integer", "minimum": 0, "maximum": 10000 }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing test `manifest.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { validateManifest, MANIFEST_VERSION, MAX_ZIP_BYTES } from '../manifest.js'

const validManifest = {
  schemaVersion: 1,
  id: 'example-api',
  version: '1.0.0',
  title: 'Example API Plugin',
  halves: {
    browser: { entry: 'browser.jsx', pages: [{ path: '/example', title: 'Example' }] },
  },
}

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = validateManifest(validManifest)
    expect(m.id).toBe('example-api')
    expect(m.version).toBe('1.0.0')
  })

  it('rejects unknown schemaVersion', () => {
    expect(() => validateManifest({ ...validManifest, schemaVersion: 2 })).toThrow(/schemaVersion/)
  })

  it('rejects id with uppercase characters', () => {
    expect(() => validateManifest({ ...validManifest, id: 'Example' })).toThrow(/id/)
  })

  it('rejects non-semver version', () => {
    expect(() => validateManifest({ ...validManifest, version: '1.0' })).toThrow(/version/)
  })

  it('rejects empty halves', () => {
    expect(() => validateManifest({ ...validManifest, halves: {} })).toThrow(/halves/)
  })

  it('rejects page path not starting with /', () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        halves: { browser: { entry: 'b.jsx', pages: [{ path: 'noSlash', title: 'x' }] } },
      }),
    ).toThrow(/path/)
  })

  it('rejects additional top-level properties', () => {
    expect(() => validateManifest({ ...validManifest, extra: true })).toThrow()
  })

  it('accepts host + browser halves together', () => {
    const m = validateManifest({
      ...validManifest,
      halves: {
        host: { entry: 'host.ts' },
        browser: { entry: 'browser.tsx' },
      },
    })
    expect(m.halves.host?.entry).toBe('host.ts')
  })

  it('accepts pre-release versions', () => {
    const m = validateManifest({ ...validManifest, version: '1.0.0-rc.1' })
    expect(m.version).toBe('1.0.0-rc.1')
  })

  it('exports MANIFEST_VERSION = 1', () => {
    expect(MANIFEST_VERSION).toBe(1)
  })

  it('exports MAX_ZIP_BYTES = 4 MiB', () => {
    expect(MAX_ZIP_BYTES).toBe(4 * 1024 * 1024)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @api-audit/core test`
Expected: FAIL with "Cannot find module '../manifest.js'".

- [ ] **Step 4: Implement `manifest-schema.ts` (ajv setup)**

```ts
import Ajv from 'ajv'
import schema from './schema/manifest.schema.json' with { type: 'json' }

const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(schema)

/** Returns null when valid, otherwise an array of human-readable messages. */
export function checkManifest(json: unknown): string[] | null {
  if (validate(json)) return null
  return (validate.errors ?? []).map((e) => {
    const path = e.instancePath || '<root>'
    return `${path} ${e.message ?? 'invalid'}${e.params ? ' ' + JSON.stringify(e.params) : ''}`
  })
}
```

- [ ] **Step 5: Implement `manifest.ts`**

```ts
import { checkManifest } from './manifest-schema.js'

export const MANIFEST_VERSION = 1
export const MAX_ZIP_BYTES = 4 * 1024 * 1024

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface PageDeclaration {
  path: string
  title: string
  icon?: string
  order?: number
}

export interface HalfEntry {
  entry: string
  pages?: PageDeclaration[]
  inject?: string[]
}

export interface Manifest {
  schemaVersion: typeof MANIFEST_VERSION
  id: string
  version: string
  title: string
  halves: {
    host?: HalfEntry
    browser?: HalfEntry
  }
  inject?: string[]
}

/**
 * Throws an Error with a multi-line `.message` listing every schema violation.
 * Returns the validated (and structurally identical) manifest on success.
 */
export function validateManifest(json: unknown): Manifest {
  const errors = checkManifest(json)
  if (errors) {
    throw new Error('Invalid manifest:\n  - ' + errors.join('\n  - '))
  }
  // json is validated above; the cast is safe because checkManifest guarantees shape.
  return json as Manifest
}
```

- [ ] **Step 6: Re-export from `index.ts`**

Append:

```ts
export type { Manifest, HalfEntry, PageDeclaration } from './manifest.js'
export { validateManifest, MANIFEST_VERSION, MAX_ZIP_BYTES } from './manifest.js'
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @api-audit/core test`
Expected: PASS (6 + 11 = 17 tests).

- [ ] **Step 8: Verify build (the JSON schema must be emitted)**

Run: `pnpm --filter @api-audit/core build`
Expected: `lib/schema/manifest.schema.json` exists alongside `lib/manifest.js`. If the JSON is missing, add `"resolveJsonModule": true` is already on (base) and NodeNext imports need explicit `with { type: 'json' }` — confirm step 4's import syntax matches NodeNext. If tsc complains about the `import ... with` syntax, fall back to:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const __dirname = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(__dirname, 'schema/manifest.schema.json'), 'utf8'))
```

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/schema/manifest.schema.json packages/core/src/manifest-schema.ts packages/core/src/manifest.ts packages/core/src/index.ts packages/core/src/__tests__/manifest.test.ts
git commit -m "feat(core): Manifest types + JSON Schema + validateManifest()"
```

---

## Task 6: redactCredentials()

**Files:**
- Create: `packages/core/src/credentials.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/credentials.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `redactCredentials(headers, opts?): { headers, redacted }` and `SENSITIVE_HEADER_NAMES` constant.

**Behavior** (per spec §4.2 / §7.4): header-name match is **case-insensitive**. Matched headers have their values replaced by `{ present: true, hash: sha256(value).slice(0, 16) }`. The hash uses Node's `node:crypto`.

- [ ] **Step 1: Write the failing test `credentials.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { redactCredentials, SENSITIVE_HEADER_NAMES } from '../credentials.js'

describe('redactCredentials', () => {
  it('returns headers unchanged when no sensitive names present', () => {
    const input = { 'content-type': 'application/json', 'x-custom': 'v' }
    const result = redactCredentials(input)
    expect(result.headers).toEqual(input)
    expect(result.redacted).toEqual([])
  })

  it('redacts authorization header (case-insensitive) and produces a 16-char hash', () => {
    const result = redactCredentials({ Authorization: 'Bearer secret-token-12345' })
    expect(result.redacted).toHaveLength(1)
    expect(result.redacted[0]!.name).toBe('authorization')
    const redacted = result.headers['authorization']
    expect(redacted).toMatch(/^\{.*\}$/)
    const parsed = JSON.parse(redacted as string)
    expect(parsed.present).toBe(true)
    expect(parsed.hash).toMatch(/^[a-f0-9]{16}$/)
  })

  it('redacts cookie, x-api-key, x-auth-token, proxy-authorization', () => {
    const result = redactCredentials({
      Cookie: 'sid=abc',
      'x-api-key': 'k',
      'X-Auth-Token': 't',
      'proxy-authorization': 'Basic x',
      'X-Custom': 'keep-me',
    })
    const redactedNames = result.redacted.map((r) => r.name).sort()
    expect(redactedNames).toEqual(['cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token'])
    expect(result.headers['x-custom']).toBe('keep-me')
  })

  it('produces stable hash for the same value', () => {
    const a = redactCredentials({ authorization: 'same-value' })
    const b = redactCredentials({ authorization: 'same-value' })
    expect(a.headers['authorization']).toBe(b.headers['authorization'])
  })

  it('produces different hash for different values', () => {
    const a = redactCredentials({ authorization: 'value-1' })
    const b = redactCredentials({ authorization: 'value-2' })
    expect(a.headers['authorization']).not.toBe(b.headers['authorization'])
  })

  it('does not mutate the input object', () => {
    const input = { Authorization: 'Bearer x' }
    const snapshot = JSON.stringify(input)
    redactCredentials(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('exports the standard sensitive header set', () => {
    expect(SENSITIVE_HEADER_NAMES).toContain('authorization')
    expect(SENSITIVE_HEADER_NAMES).toContain('cookie')
    expect(SENSITIVE_HEADER_NAMES).toContain('x-api-key')
    expect(SENSITIVE_HEADER_NAMES).toContain('x-auth-token')
    expect(SENSITIVE_HEADER_NAMES).toContain('proxy-authorization')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @api-audit/core test`
Expected: FAIL with "Cannot find module '../credentials.js'".

- [ ] **Step 3: Implement `credentials.ts`**

```ts
import { createHash } from 'node:crypto'

/**
 * Header names (lowercase) whose values are treated as credentials.
 * Spec §4.2: matched case-insensitively; replaced with a stable 16-char
 * sha256 prefix plus `{ present: true }` so the audit record proves the
 * header existed without disclosing its value.
 */
export const SENSITIVE_HEADER_NAMES: readonly string[] = [
  'authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
]

const REDACTED_VALUE = (hash: string): string =>
  JSON.stringify({ present: true, hash })

export interface RedactedCredential {
  name: string
  hash: string
}

export interface RedactResult {
  /** New headers object (input is never mutated). */
  headers: Record<string, string>
  /** Names (lowercase) of headers that were redacted. */
  redacted: RedactedCredential[]
}

/**
 * Replace credential headers with a stable hash reference. Input is
 * shallow-copied before mutation; the caller's object is untouched.
 */
export function redactCredentials(
  input: Record<string, string>,
): RedactResult {
  const headers: Record<string, string> = { ...input }
  const redacted: RedactedCredential[] = []
  for (const name of SENSITIVE_HEADER_NAMES) {
    // Find case-insensitive match
    const matchedKey = Object.keys(headers).find((k) => k.toLowerCase() === name)
    if (matchedKey === undefined) continue
    const value = headers[matchedKey]!
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 16)
    // Normalize the output key to lowercase
    if (matchedKey !== name) delete headers[matchedKey]
    headers[name] = REDACTED_VALUE(hash)
    redacted.push({ name, hash })
  }
  return { headers, redacted }
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Append:

```ts
export {
  redactCredentials,
  SENSITIVE_HEADER_NAMES,
  type RedactResult,
  type RedactedCredential,
} from './credentials.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @api-audit/core test`
Expected: PASS (17 + 7 = 24 tests).

- [ ] **Step 6: Verify build**

Run: `pnpm --filter @api-audit/core build`
Expected: `lib/credentials.js` + `lib/credentials.d.ts` exist. No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/credentials.ts packages/core/src/index.ts packages/core/src/__tests__/credentials.test.ts
git commit -m "feat(core): redactCredentials() with case-insensitive header matching"
```

---

## Task 7: Review Checklist CI + Final Verification

**Files:**
- Create: `tools/check-spec.sh`
- Modify: `package.json` (add `check:spec` script)
- Modify: `packages/core/src/index.ts` (final public-API summary)

**Interfaces:**
- Consumes: existing source tree.
- Produces: a shell script that enforces the "no cordis declare-module in core" rule (spec §2.4 + §9.4); plus a final green build/test across the workspace.

- [ ] **Step 1: Write `tools/check-spec.sh`**

```bash
#!/usr/bin/env bash
# Spec compliance checks (spec §9.4).
# Fails non-zero if any rule is violated.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

failed=0

check_no_cordis_augmentation_in_core() {
  local hits
  hits=$(rg -n "declare module ['\"]cordis['\"]" packages/core/src/ || true)
  if [ -n "$hits" ]; then
    echo "FAIL: packages/core must have zero cordis Context augmentation (spec §2.4):"
    echo "$hits"
    failed=1
  fi
}

check_no_arrow_register_in_pages() {
  # Pages service will live in packages/client (Plan 3). The rule only applies
  # to the eventual pages service; here we just make sure no proto pages/
  # module has snuck in with an arrow register yet.
  local hits
  hits=$(rg -n 'register\s*=\s*\([^)]*\)\s*=>|register:\s*\(.*\)\s*=>' packages/client/src/pages/ 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "FAIL: pages register must be a prototype method, not an arrow (spec §5.3):"
    echo "$hits"
    failed=1
  fi
}

check_no_cordis_dir_in_core() {
  # Belt-and-braces: the core package must not have a direct cordis import.
  local hits
  hits=$(rg -n "from ['\"]cordis['\"]" packages/core/src/ || true)
  if [ -n "$hits" ]; then
    echo "FAIL: packages/core must not import cordis (spec §3 — pure contracts):"
    echo "$hits"
    failed=1
  fi
}

check_no_cordis_dir_in_core
check_no_cordis_augmentation_in_core
check_no_arrow_register_in_pages

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "spec compliance: OK"
```

- [ ] **Step 2: Make it executable**

Run (Git Bash on Windows): `chmod +x tools/check-spec.sh`
Expected: no output.

- [ ] **Step 3: Add a `check:spec` script to root `package.json`**

Patch `package.json` scripts (add a new line inside the existing `"scripts"` object):

```json
    "check:spec": "bash tools/check-spec.sh",
```

Resulting scripts block:

```json
  "scripts": {
    "build": "pnpm exec nx run-many -t build",
    "test": "pnpm exec nx run-many -t test",
    "lint": "pnpm exec nx run-many -t lint",
    "check:spec": "bash tools/check-spec.sh"
  },
```

- [ ] **Step 4: Finalize `packages/core/src/index.ts`**

Replace the file with the complete public API:

```ts
/**
 * @api-audit/core — pure contract layer (spec §3).
 *
 * Zero cordis dependency; zero Context augmentation. This package is
 * consumable by both host (Node) and client (browser) without dragging
 * cordis or any other runtime dependency across the boundary.
 */

// Version
export const CORE_API_VERSION = '0.0.0'

// AuditClient
export type { AuditClient, AuditResponse, RequestConfig } from './audit-client.js'
export { MAX_BODY_BYTES } from './audit-client.js'

// Middleware
export type { Middleware, MiddlewareContext, Next } from './middleware.js'
export { compose } from './middleware.js'

// Manifest
export type { Manifest, HalfEntry, PageDeclaration } from './manifest.js'
export { validateManifest, MANIFEST_VERSION, MAX_ZIP_BYTES } from './manifest.js'

// Credentials
export {
  redactCredentials,
  SENSITIVE_HEADER_NAMES,
  type RedactResult,
  type RedactedCredential,
} from './credentials.js'
```

- [ ] **Step 5: Verify everything passes end-to-end**

Run each in order:

```bash
pnpm install
pnpm --filter @api-audit/core build
pnpm --filter @api-audit/core test
pnpm check:spec
pnpm exec nx run-many -t build
pnpm exec nx run-many -t test
```

Expected:
- `pnpm install`: clean, no warnings.
- `pnpm --filter @api-audit/core build`: succeeds, emits `lib/`.
- `pnpm --filter @api-audit/core test`: 24 tests pass.
- `pnpm check:spec`: prints `spec compliance: OK`.
- `pnpm exec nx run-many -t build`: `core` builds successfully.
- `pnpm exec nx run-many -t test`: `core` tests run successfully via Nx.

If any step fails, do not commit; debug first.

- [ ] **Step 6: Commit**

```bash
git add tools/check-spec.sh package.json packages/core/src/index.ts
git commit -m "chore: spec compliance checklist + finalize core public API"
```

---

## Self-Review (run after writing)

- [ ] **Spec coverage check:**
  - Spec §3.1 AuditClient / RequestConfig / AuditResponse / MAX_BODY_BYTES → Task 3 ✓
  - Spec §3.2 Middleware / MiddlewareContext / Next / onion compose → Task 4 ✓
  - Spec §3.3 Manifest schema (id regex, version regex, page path regex) → Task 5 ✓
  - Spec §3.4 validateManifest runtime export → Task 5 ✓
  - Spec §3.4 MAX_ZIP_BYTES export → Task 5 ✓
  - Spec §3.4 redactCredentials → Task 6 ✓
  - Spec §9.4 CI review checklist (no cordis in core; pages prototype rule once applicable) → Task 7 ✓
  - Spec §2.4 TS engineering (strict, NodeNext, composite) → Tasks 1 (base) + 2 (per-package) ✓
  - Spec §11 implementation route step 1 (packages/core) → this entire plan ✓
  - Gaps: none for this plan's scope.

- [ ] **Placeholder scan:**
  - No "TBD" / "TODO" / "fill in" present.
  - No "implement later" / "similar to Task N" lazy references.
  - Every code step has actual code (no "write appropriate test").

- [ ] **Type/name consistency:**
  - `MAX_BODY_BYTES` defined in `audit-client.ts` (Task 3) and re-exported in `index.ts` (Task 3→7); used in tests Task 3.
  - `MANIFEST_VERSION`, `MAX_ZIP_BYTES` defined in `manifest.ts` (Task 5); re-exported in `index.ts` (Task 5→7); used in tests Task 5.
  - `SENSITIVE_HEADER_NAMES` defined in `credentials.ts` (Task 6); re-exported in `index.ts` (Task 6→7); used in tests Task 6.
  - `Middleware<TContext, TResponse>` type signature matches across `middleware.ts` and tests.
  - `compose()` signature matches across `middleware.ts`, tests, and Task 4's index.ts re-export.
  - `validateManifest(json): Manifest` signature matches across `manifest.ts` and tests.

- [ ] **OK to commit. Proceed to execution.**
