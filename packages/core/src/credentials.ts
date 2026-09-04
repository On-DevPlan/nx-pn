import { createHash } from 'node:crypto'

/**
 * Header names (lowercase) whose values are treated as credentials.
 *
 * NOTE (product decision 2026-09-04): the nx-pn audit middleware does NOT
 * call {@link redactCredentials} — audit records keep Authorization and other
 * credential headers verbatim (it is a personal, local audit tool; the
 * developer debugging auth needs the real value). This list + the redactor
 * are retained as an explicit library capability for callers who DO want to
 * scrub a header set, but nothing in the request path uses them by default.
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
