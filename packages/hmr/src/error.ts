/**
 * Error formatting helpers for hmr.
 */
export class HmrError extends Error {
  constructor(public readonly code: string, message: string, public readonly context?: Record<string, unknown>) {
    super(message)
    this.name = 'HmrError'
  }
}

export function formatBuildFailure(pluginId: string, stdout: string, stderr: string): string {
  const out = (stderr || stdout || '').trim()
  if (!out) return `${pluginId}: build failed with no output`
  return `${pluginId}: build failed\n${out}`
}
