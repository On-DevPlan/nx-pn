/**
 * Shared host-liveness probe. `nx-pn` commands first ask "is a long-running
 * host alive on --port?"; yes → drive its REST routes (hot semantics), no →
 * boot an ephemeral host over the same --data-dir (cold-start, ledger/domain
 * only). This module owns the probe so command modules and main.ts never
 * import each other (avoids an ESM cycle).
 */

/**
 * Probe whether a long-running host is alive on `port`. Uses `GET
 * /api/plugins` as the liveness signal (there is no /api/health route;
 * this list route is stable and returns 200 {"ok":true,...} on a live
 * host). Returns false on connection error or non-200.
 */
export async function probeHost(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/plugins`, { signal: AbortSignal.timeout(3000) })
    return res.status === 200
  } catch {
    return false
  }
}
