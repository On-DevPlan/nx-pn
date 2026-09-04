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

  it('stores layout + routes as opaque data (fullscreen contract)', () => {
    const reg = new PageRegistry()
    const Dashboard = function Dashboard() {}
    const KeysView = function KeysView() {}
    reg.register({
      pluginId: 'p',
      path: '/p',
      title: 'P',
      layout: 'fullscreen',
      routes: [
        { path: '/', Component: Dashboard },
        { path: '/keys', Component: KeysView },
      ],
      Component: Dashboard,
    })
    const snap = reg.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]?.layout).toBe('fullscreen')
    expect(snap[0]?.routes).toHaveLength(2)
    expect(snap[0]?.routes?.[1]).toEqual({ path: '/keys', Component: KeysView })
    // upsert flows the new shape through too
    reg.register({ pluginId: 'p', path: '/p', title: 'P2' })
    expect(reg.snapshot()[0]?.layout).toBeUndefined()
    expect(reg.snapshot()[0]?.routes).toBeUndefined()
  })

  it('default registrations stay shell layout (flat-page contract intact)', () => {
    const reg = new PageRegistry()
    reg.register({ pluginId: 'p', path: '/x', title: 'X', Component: function X() {} })
    expect(reg.snapshot()[0]?.layout).toBeUndefined()
    expect(reg.snapshot()[0]?.routes).toBeUndefined()
  })
})
