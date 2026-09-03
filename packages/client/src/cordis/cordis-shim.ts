/**
 * Local cordis import shim for the browser runtime.
 *
 * Why: cordis 4.0.0-rc.9's d.ts re-exports via `export *`, which our
 * `module: NodeNext` + `verbatimModuleSyntax: true` config treats as
 * type-only — TypeScript sees the module as empty (the runtime is
 * fine). This is the exact problem `packages/host/src/cordis/cordis-shim.ts`
 * solves on the Node side; this file mirrors it for the browser side
 * (same package, same d.ts). See host's cordis-shim.ts header for the
 * full rationale.
 *
 * Re-exports the minimal structural types consumed by client
 * (`./minimal-types.ts`, a copy of host's) so client never imports
 * cordis's d.ts directly in a way that breaks TS.
 */

import * as cordisNs from 'cordis'
import {
  ServiceBase,
  type Context as MinimalContext,
  type Fiber as MinimalFiber,
  type CordisRegistry as CordisRegistryT,
  type CordisPlugin as CordisPluginT,
} from './minimal-types.js'

export type Context = MinimalContext
export type Fiber = MinimalFiber
export type Service = ServiceBase
export type CordisRegistry = CordisRegistryT
export type CordisPlugin = CordisPluginT
export { ServiceBase } from './minimal-types.js'
export { FiberState } from './minimal-types.js'

interface CordisContextCtor {
  new (): Context
  readonly effect: unique symbol
  readonly filter: unique symbol
  readonly isolate: unique symbol
  readonly intercept: unique symbol
  is(value: unknown): boolean
}

/** Runtime `new Context()` factory. */
export const CordisContext: CordisContextCtor = (cordisNs as unknown as { Context: CordisContextCtor }).Context

/**
 * Runtime Service base class (abstract in cordis). Subclasses extend
 * this value and call `super(ctx, 'name')`. Typed via the vendored
 * `ServiceBase` so `extends CordisService` type-checks.
 */
export const CordisService: typeof ServiceBase = (cordisNs as unknown as { Service: typeof ServiceBase }).Service
