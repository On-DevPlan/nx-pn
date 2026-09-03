import { describe, it, expect } from 'vitest'
import { MAX_BODY_BYTES } from '../audit-client.js'

describe('audit-client constants', () => {
  it('exports MAX_BODY_BYTES = 1 MiB', () => {
    expect(MAX_BODY_BYTES).toBe(1024 * 1024)
  })
})
