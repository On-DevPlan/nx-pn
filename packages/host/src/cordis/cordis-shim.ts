/**
 * Local cordis import shim.
 *
 * Why: cordis 4.0.0-rc.9's d.ts re-exports via `export *`, which our
 * `module: NodeNext` + `verbatimModuleSyntax: true` config treats as
 * type-only — TypeScript sees the module as empty (the runtime is
 * fine). This file:
 *
 *   - provides runtime constructors (`CordisContext`, `CordisService`)
 *     via a namespace-import cast, and
 *   - re-exports the minimal structural types host consumes
 *     (Context, Fiber, Service) declared in `./minimal-types.ts`.
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