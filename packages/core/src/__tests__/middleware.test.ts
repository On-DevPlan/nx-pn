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
