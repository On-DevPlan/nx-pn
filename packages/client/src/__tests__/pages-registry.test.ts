import { describe, it, expect } from 'vitest'
import { PageRegistry } from '../pages/page-registry.js'

describe('PageRegistry', () => {
  it('stores registrations and returns an ordered snapshot', () => {
    const reg = new PageRegistry()
    reg.register({ pluginId: 'a', path: '/b', title: 'B' })
    reg.register({ pluginId: 'a', path: '/a', title: 'A' })
    reg.register({ pluginId: 'z', path: '/z', title: 'Z', order: 10 })
    const snap = reg.snapshot()
    expect(snap.map((e) => e.path)).toEqual(['/z', '/a', '/b'])
    expect(snap[0]?.title).toBe('Z')
  })

  it('upserts the same pluginId+path in place', () => {
    const reg = new PageRegistry()
    reg.register({ pluginId: 'p', path: '/x', title: 'v1' })
    reg.register({ pluginId: 'p', path: '/x', title: 'v2' })
    expect(reg.size).toBe(1)
    expect(reg.snapshot()[0]?.title).toBe('v2')
  })

  it('unregister removes a single entry', () => {
    const reg = new PageRegistry()
    reg.register({ pluginId: 'p', path: '/x', title: 'X' })
    reg.register({ pluginId: 'p', path: '/y', title: 'Y' })
    reg.unregister('p', '/x')
    expect(reg.snapshot().map((e) => e.path)).toEqual(['/y'])
  })

  it('unregisterAll removes every entry owned by a plugin', () => {
    const reg = new PageRegistry()
    reg.register({ pluginId: 'p', path: '/x', title: 'X' })
    reg.register({ pluginId: 'p', path: '/y', title: 'Y' })
    reg.register({ pluginId: 'q', path: '/q', title: 'Q' })
    reg.unregisterAll('p')
    expect(reg.snapshot().map((e) => e.path)).toEqual(['/q'])
  })

  it('rejects paths that do not start with /', () => {
    const reg = new PageRegistry()
    expect(() => reg.register({ pluginId: 'p', path: 'x', title: 'X' })).toThrow(/must start/)
  })

  it('notifies subscribers on mutation', () => {
    const reg = new PageRegistry()
    const seen: string[] = []
    reg.subscribe(() => seen.push('tick'))
    reg.register({ pluginId: 'p', path: '/x', title: 'X' })
    reg.unregister('p', '/x')
    reg.unregister('p', '/missing') // no-op → no notify
    expect(seen).toEqual(['tick', 'tick'])
  })
})
