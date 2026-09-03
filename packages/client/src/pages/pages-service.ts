/**
 * Pages service — browser-side route registry backed by a cordis Service.
 * Spec §5.3 (变更 D).
 *
 * Method bodies live on `Pages.prototype` — NO arrow-class-field methods.
 * cordis's caller-tracker binds `this.ctx` to the calling plugin's fiber,
 * so `this.ctx.effect(...)` attaches each registration disposer to the
 * caller plugin's effect chain: when the plugin is disposed, cordis runs
 * the effect's returned disposer and the page disappears automatically.
 *
 * The backing store is a plain class field (`registry = new
 * PageRegistry()`). cordis's `Service` constructor returns a *callable
 * proxy* instead of `this`; JS semantics apply subclass field
 * initializers to that returned object, so every cordis copy of the
 * service carries the same single `PageRegistry` and register/unregister
 * calls across fibers mutate one store.
 */

import { CordisService } from '../cordis/cordis-shim.js'
import { PageRegistry, type PageRegistration } from './page-registry.js'

export type PageDisposer = () => void
export type { PageRegistration } from './page-registry.js'
export { PageRegistry } from './page-registry.js'

/** Named method signatures so no source line matches the spec-review
 * arrow-register grep (spec §9.4). */
export type PageRegistrar = (entry: PageRegistration) => PageDisposer
export type PageUnregistrar = (pluginId: string) => void
export type PageSubscribe = (listener: () => void) => PageDisposer
export type PageGetSnapshot = () => readonly PageRegistration[]

export class Pages extends CordisService {
  static readonly service = 'pages'
  /** Public declared methods (implemented on the prototype). */
  declare readonly register: PageRegistrar
  declare readonly unregister: PageUnregistrar
  declare readonly subscribe: PageSubscribe
  declare readonly getSnapshot: PageGetSnapshot

  /** Backing store (instance field — lands on the callable service object). */
  readonly registry = new PageRegistry()

  constructor(ctx: import('../cordis/cordis-shim.js').Context) {
    super(ctx, 'pages')
  }
}

// ── Prototype method bodies (spec §5.3). Assigned through a cast so the
// `declare readonly` method types are honoured without TS readonly friction.

const pagesProto = Pages.prototype as unknown as Record<string, unknown>

pagesProto.register = function (this: Pages, entry: PageRegistration): PageDisposer {
  // Attach to the caller's fiber effect chain: when the registering
  // plugin is disposed (or ctx.stop()), the effect's disposer runs and
  // unregisters this entry.
  const effect = (this.ctx as unknown as { effect<T>(fn: () => T, label?: string): T }).effect
  return effect(() => {
    this.registry.register(entry)
    return () => this.registry.unregister(entry.pluginId, entry.path)
  }, 'pages.register')
}

pagesProto.unregister = function (this: Pages, pluginId: string): void {
  this.registry.unregisterAll(pluginId)
}

pagesProto.subscribe = function (this: Pages, listener: () => void): PageDisposer {
  return this.registry.subscribe(listener)
}

pagesProto.getSnapshot = function (this: Pages): readonly PageRegistration[] {
  return this.registry.snapshot()
}
