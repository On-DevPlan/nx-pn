/**
 * case3-p — host half for Case 3 Test Plugin.
 */

interface HostCtx {
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void }
  on(event: string, handler: (payload?: unknown) => unknown): unknown
  auditClient: {
    get(url: string, config?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<{ status: number; statusText: string; bodyText: string }>
  }
  pluginStorage?: {
    ns: string
    table(name: 'settings' | 'cache' | 'state'): {
      get(key: string): unknown
      put(key: string, value: unknown): Promise<void>
    }
  }
}

type PluginFn = ((ctx: HostCtx, config?: { name?: string }) => void) & { inject?: string[] }

const plugin = async function plugin(ctx: HostCtx, config?: { name?: string }): Promise<void> {
  const id = config?.name ?? 'case3-p'
  ctx.logger.info(`[${id}] host half active`)

  let bootCount = 0
  if (ctx.pluginStorage) {
    const settings = ctx.pluginStorage.table('settings')
    const current = settings.get('bootCount')
    bootCount = (typeof current === 'number' ? current : 0) + 1
    try {
      await settings.put('bootCount', bootCount)
      ctx.logger.info(`[${id}] boot #${bootCount} recorded`)
    } catch (err) {
      ctx.logger.warn(`[${id}] bootCount persist failed: ${(err as Error).message}`)
    }
  }

  ctx.on('case3-p/boot-count', () => ({ ok: true, data: { bootCount } }))
}

;(plugin as PluginFn).inject = ['auditClient']
export default plugin
