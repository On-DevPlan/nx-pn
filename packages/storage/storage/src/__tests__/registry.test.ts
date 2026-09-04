import { describe, expect, it } from 'vitest'
import { BackendRegistry, storageBackendServiceKey, Storage } from '../index.js'
import type { StorageBackend } from '../index.js'

const fakeBackend = (): StorageBackend => ({ close: async () => {} })

describe('BackendRegistry', () => {
  it('registers, resolves, and disposes names', () => {
    const registry = new BackendRegistry()
    const backend = fakeBackend()
    const dispose = registry.register('json', backend)
    expect(registry.get('json')).toBe(backend)
    expect(registry.names()).toEqual(['json'])
    dispose()
    expect(registry.names()).toEqual([])
    expect(() => registry.get('json')).toThrowMatchingObject({ code: 'backend-not-found' })
  })

  it('rejects duplicate names', () => {
    const registry = new BackendRegistry()
    registry.register('json', fakeBackend())
    expect(() => registry.register('json', fakeBackend())).toThrowMatchingObject({ code: 'duplicate-backend' })
  })
})

describe('Storage hub', () => {
  it('derives stable lifecycle service keys for named backends', () => {
    expect(storageBackendServiceKey('json')).toBe('storage.backend.json')
    expect(storageBackendServiceKey('tenant-a')).toBe('storage.backend.tenant-a')
  })

  it('exposes the backend registry plus form mounting', () => {
    const storage = new Storage()

    const facility = { marker: true }
    const dispose = storage.mount('domain' as never, facility as never)
    expect(storage.form('domain' as never)).toBe(facility)
    expect(storage.domain).toBe(facility)
    expect(() => storage.mount('domain' as never, facility as never)).toThrowMatchingObject({
      code: 'duplicate-mount',
    })
    dispose()
    expect(() => storage.form('domain' as never)).toThrowMatchingObject({ code: 'form-not-mounted' })
    expect(() => storage.domain).toThrowMatchingObject({ code: 'form-not-mounted' })
  })

  it('ignores a stale disposer after dispose and re-mount / re-register', () => {
    const storage = new Storage()
    const first = { first: true }
    const second = { second: true }
    const staleMount = storage.mount('domain' as never, first as never)
    staleMount()
    storage.mount('domain' as never, second as never)
    staleMount()
    expect(storage.form('domain' as never)).toBe(second)

    const backendA = fakeBackend()
    const backendB = fakeBackend()
    const staleRegister = storage.backend.register('json', backendA)
    staleRegister()
    storage.backend.register('json', backendB)
    staleRegister()
    expect(storage.backend.get('json')).toBe(backendB)
  })
})

expect.extend({
  toThrowMatchingObject(received: () => unknown, expected: object) {
    try {
      received()
    } catch (error) {
      const pass = Object.entries(expected).every(
        entry => (error as Record<string, unknown>)[entry[0]] === entry[1],
      )
      return { pass, message: () => `expected thrown error to match ${JSON.stringify(expected)}, got ${String(error)}` }
    }
    return { pass: false, message: () => 'expected function to throw' }
  },
})

declare module 'vitest' {
  interface Assertion<T> {
    toThrowMatchingObject(expected: object): T
  }
}
