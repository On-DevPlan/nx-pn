import { createHash } from 'node:crypto'

/**
 * Header names (lowercase) whose values are treated as credentials.
 * Spec §4.2: matched case-insensitively; replaced with a stable 16-char
 * sha256 prefix plus `{ present: true }` so the audit record proves the
 * header existed without disclosing its value.
 */
export const SENSITIVE_HEADER_NAMES: readonly string[] = [
  'authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
]

const REDACTED_VALUE = (hash: string): string =>
  JSON.stringify({ present: true, hash })

export interface RedactedCredential {
  name: string
  hash: string
}

export interface RedactResult {
  /** New headers object (input is never mutated). */
  headers: Record<string, string>
  /** Names (lowercase) of headers that were redacted. */
  redacted: RedactedCredential[]
}

/**
 * Replace credential headers with a stable hash reference. Input is
 * shallow-copied before mutation; the caller's object is untouched.
 */
export function redactCredentials(
  input: Record<string, string>,
): RedactResult {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    headers[k.toLowerCase()] = v
  }
  const redacted: RedactedCredential[] = []
  for (const name of SENSITIVE_HEADER_NAMES) {
    // Find case-insensitive match
    const matchedKey = Object.keys(headers).find((k) => k === name)
    if (matchedKey === undefined) continue
    const value = headers[matchedKey]!
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 16)
    headers[name] = REDACTED_VALUE(hash)
    redacted.push({ name, hash })
  }
  return { headers, redacted }
}
