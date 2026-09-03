/**
 * Minimal structural types for the slice of cordis that packages/host
 * uses. cordis 4.0.0-rc.9's d.ts is unusable under our TS config (see
 * cordis-shim.ts), so these declarations mirror the runtime shapes.
 */

/** The dynamic-plugin type accepted by `registry.plugin(...)`. */
export type CordisPlugin =
  | ((ctx: CordisContextShape, config?: any) => unknown)
  | { name?: string; apply(ctx: CordisContextShape, config?: any): unknown; inject?: unknown }
  | (new (ctx: CordisContextShape, config?: any) => unknown)

/** Plugin execution handle: Fiber & PromiseLike<Fiber>. */
export interface Fiber {
  uid: number | null
  readonly ctx: unknown
  config: any
  state: number
  readonly dispose: () => Promise<void>
  inertia?: Promise<void>
  /** Await the plugin's inertia (its activate/load work). */
  await(): Promise<void>
  then<TResult1 = Fiber, TResult2 = never>(
    onfulfilled?: ((value: Fiber) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>
}

export interface CordisRegistry {
  plugin(plugin: CordisPlugin, config?: any): Fiber
}

/** Structural Context with the members we use. */
export interface CordisContextShape {
  registry: CordisRegistry
  events: unknown
  logger: {
    info(format: unknown, ...args: unknown[]): void
    warn(format: unknown, ...args: unknown[]): void
    error(format: unknown, ...args: unknown[]): void
  }
  reflect: unknown
  fiber: Fiber
  root: CordisContextShape
  baseUrl?: string
  effect<T>(fn: () => T): T
  extend(meta?: object): this
  isolate(name: string, label?: symbol): this
  [key: string]: unknown
}

/** Context alias. */
export type Context = CordisContextShape

/**
 * Service base class (abstract in cordis). Subclasses extend this and
 * call `super(ctx, 'serviceName')`; method bodies live on the prototype.
 */
export abstract class ServiceBase {
  public name!: string
  protected ctx!: CordisContextShape
  constructor(ctx: CordisContextShape, name: string) {
    this.ctx = ctx
    this.name = name
  }
  [key: string]: unknown
}

/** Fiber-state constants mirroring cordis's FiberState enum. */
export const FiberState = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const