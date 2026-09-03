/**
 * Per-request context passed through the middleware chain. Filled by the
 * audit middleware (initiator, headers, body — see spec §3.2) and threaded
 * through every downstream middleware via the `compose()` helper.
 */
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
