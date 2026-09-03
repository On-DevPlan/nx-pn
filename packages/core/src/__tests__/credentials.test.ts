import { describe, it, expect } from 'vitest'
import { redactCredentials, SENSITIVE_HEADER_NAMES } from '../credentials.js'

describe('redactCredentials', () => {
  it('returns headers unchanged when no sensitive names present', () => {
    const input = { 'content-type': 'application/json', 'x-custom': 'v' }
    const result = redactCredentials(input)
    expect(result.headers).toEqual(input)
    expect(result.redacted).toEqual([])
  })

  it('redacts authorization header (case-insensitive) and produces a 16-char hash', () => {
    const result = redactCredentials({ Authorization: 'Bearer secret-token-12345' })
    expect(result.redacted).toHaveLength(1)
    expect(result.redacted[0]!.name).toBe('authorization')
    const redacted = result.headers['authorization']
    expect(redacted).toMatch(/^\{.*\}$/)
    const parsed = JSON.parse(redacted as string)
    expect(parsed.present).toBe(true)
    expect(parsed.hash).toMatch(/^[a-f0-9]{16}$/)
  })

  it('redacts cookie, x-api-key, x-auth-token, proxy-authorization', () => {
    const result = redactCredentials({
      Cookie: 'sid=abc',
      'x-api-key': 'k',
      'X-Auth-Token': 't',
      'proxy-authorization': 'Basic x',
      'X-Custom': 'keep-me',
    })
    const redactedNames = result.redacted.map((r) => r.name).sort()
    expect(redactedNames).toEqual(['cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token'])
    expect(result.headers['x-custom']).toBe('keep-me')
  })

  it('produces stable hash for the same value', () => {
    const a = redactCredentials({ authorization: 'same-value' })
    const b = redactCredentials({ authorization: 'same-value' })
    expect(a.headers['authorization']).toBe(b.headers['authorization'])
  })

  it('produces different hash for different values', () => {
    const a = redactCredentials({ authorization: 'value-1' })
    const b = redactCredentials({ authorization: 'value-2' })
    expect(a.headers['authorization']).not.toBe(b.headers['authorization'])
  })

  it('does not mutate the input object', () => {
    const input = { Authorization: 'Bearer x' }
    const snapshot = JSON.stringify(input)
    redactCredentials(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('exports the standard sensitive header set', () => {
    expect(SENSITIVE_HEADER_NAMES).toContain('authorization')
    expect(SENSITIVE_HEADER_NAMES).toContain('cookie')
    expect(SENSITIVE_HEADER_NAMES).toContain('x-api-key')
    expect(SENSITIVE_HEADER_NAMES).toContain('x-auth-token')
    expect(SENSITIVE_HEADER_NAMES).toContain('proxy-authorization')
  })
})
