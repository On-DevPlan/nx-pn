import { describe, it, expect } from 'vitest'
import { AuditRingBuffer } from '../client/ring-buffer.js'

describe('AuditRingBuffer', () => {
  it('push assigns monotonic ids', () => {
    const buf = new AuditRingBuffer<{ id: number }>()
    const a = buf.push({ id: 0 })
    const b = buf.push({ id: 0 })
    const c = buf.push({ id: 0 })
    expect(a.id).toBe(1)
    expect(b.id).toBe(2)
    expect(c.id).toBe(3)
  })

  it('snapshot returns insertion-ordered copy', () => {
    const buf = new AuditRingBuffer<{ id: number; n: number }>()
    buf.push({ id: 0, n: 10 })
    buf.push({ id: 0, n: 20 })
    buf.push({ id: 0, n: 30 })
    expect(buf.snapshot().map((r) => r.n)).toEqual([10, 20, 30])
  })

  it('FIFO eviction at capacity', () => {
    const buf = new AuditRingBuffer<{ id: number; n: number }>({ capacity: 3 })
    for (let i = 1; i <= 5; i++) buf.push({ id: 0, n: i })
    expect(buf.snapshot().map((r) => r.n)).toEqual([3, 4, 5])
    expect(buf.size).toBe(3)
    expect(buf.lastId).toBe(5)
  })

  it('since returns records strictly newer than the given id', () => {
    const buf = new AuditRingBuffer<{ id: number; n: number }>()
    buf.push({ id: 0, n: 1 })
    buf.push({ id: 0, n: 2 })
    buf.push({ id: 0, n: 3 })
    expect(buf.since(1).map((r) => r.n)).toEqual([2, 3])
  })

  it('get returns the matching record', () => {
    const buf = new AuditRingBuffer<{ id: number; n: number }>()
    buf.push({ id: 0, n: 1 })
    buf.push({ id: 0, n: 2 })
    expect(buf.get(2)?.n).toBe(2)
    expect(buf.get(99)).toBeUndefined()
  })

  it('clear empties everything', () => {
    const buf = new AuditRingBuffer<{ id: number }>()
    buf.push({ id: 0 })
    buf.push({ id: 0 })
    buf.clear()
    expect(buf.size).toBe(0)
    expect(buf.lastId).toBe(0)
  })

  it('next id continues monotonically after eviction', () => {
    const buf = new AuditRingBuffer<{ id: number }>({ capacity: 2 })
    buf.push({ id: 0 })
    buf.push({ id: 0 })
    buf.push({ id: 0 }) // evicts the first
    expect(buf.lastId).toBe(3)
    expect(buf.snapshot().map((r) => r.id)).toEqual([2, 3])
  })
})