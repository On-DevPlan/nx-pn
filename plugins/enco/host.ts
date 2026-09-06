/**
 * enco — encoding/decoding utility plugin.
 * Provides base64, URL, and hex encoding/decoding via cordis events.
 */

interface HostCtx {
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void }
  on(event: string, handler: (payload?: unknown) => unknown): unknown
}

type PluginFn = ((ctx: HostCtx, config?: { name?: string }) => void) & { inject?: string[] }

const ENCODINGS = ['base64', 'url', 'hex'] as const
type Encoding = (typeof ENCODINGS)[number]

const plugin = async function plugin(ctx: HostCtx, config?: { name?: string }): Promise<void> {
  const id = config?.name ?? 'enco'
  ctx.logger.info('enco boot')

  ctx.on('enco/encode', (payload: unknown) => {
    const { text, encoding } = payload as { text: string; encoding: string }
    if (!ENCODINGS.includes(encoding as Encoding)) {
      return { ok: false, error: `Unknown encoding: ${encoding}` }
    }
    try {
      let encoded: string
      switch (encoding) {
        case 'base64': encoded = Buffer.from(text, 'utf-8').toString('base64'); break
        case 'url': encoded = encodeURIComponent(text); break
        case 'hex': encoded = Buffer.from(text, 'utf-8').toString('hex'); break
      }
      return { ok: true, data: { encoded } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ctx.on('enco/decode', (payload: unknown) => {
    const { text, encoding } = payload as { text: string; encoding: string }
    if (!ENCODINGS.includes(encoding as Encoding)) {
      return { ok: false, error: `Unknown encoding: ${encoding}` }
    }
    try {
      let decoded: string
      switch (encoding) {
        case 'base64': decoded = Buffer.from(text, 'base64').toString('utf-8'); break
        case 'url': decoded = decodeURIComponent(text); break
        case 'hex': decoded = Buffer.from(text, 'hex').toString('utf-8'); break
      }
      return { ok: true, data: { decoded } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ctx.on('enco/list', () => {
    return { ok: true, data: { encodings: [...ENCODINGS] } }
  })
}

;(plugin as PluginFn).inject = []
export default plugin
