/**
 * echo — browser half of the user-driven request tester (spec §5.2, §5.3).
 *
 * Unlike example-api (which just proves the shared-React invariant),
 * the echo browser half provides a real working form: the user picks
 * an HTTP method, types a URL, headers, and body, and the form invokes
 * the plugin's host endpoint (`echo/ping`) via the WS RPC bridge. The
 * host half converts that into one audited request attributed to
 * `echo` — every record is replayable from the audit page.
 *
 * The component closes over the plugin's `ctx` (defined inside the
 * plugin function) so the page has direct access to the auditClient
 * proxy and the event bus. The auditClient proxy in
 * `packages/client/src/audit/client-proxy.ts` implements the per-verb
 * interface (get/post/put/patch/delete) over `rpc.invoke` — the page
 * dispatches based on the selected method.
 *
 * Compiled to an ESM string by `scripts/build-zip.mjs` (platform
 * browser, jsx automatic, shared deps external) and shipped inside the
 * zip as `browser.js`.
 */

import { useState, type ComponentType } from 'react'
import { Link, useNavigate } from 'react-router-dom'

/** Structural view of the browser plugin ctx this half relies on. */
interface BrowserCtx {
  logger: {
    info(message: string): void
  }
  /** The auditClient proxy: per-verb methods (get/post/put/patch/delete). */
  auditClient: {
    get(
      url: string,
      config?: { headers?: Record<string, string> },
    ): Promise<{ status: number; statusText: string; bodyText: string; bytes?: number; headers?: Record<string, string> }>
    post(
      url: string,
      body?: string,
      config?: { headers?: Record<string, string> },
    ): Promise<{ status: number; statusText: string; bodyText: string; bytes?: number; headers?: Record<string, string> }>
    put(
      url: string,
      body?: string,
      config?: { headers?: Record<string, string> },
    ): Promise<{ status: number; statusText: string; bodyText: string; bytes?: number; headers?: Record<string, string> }>
    patch(
      url: string,
      body?: string,
      config?: { headers?: Record<string, string> },
    ): Promise<{ status: number; statusText: string; bodyText: string; bytes?: number; headers?: Record<string, string> }>
    delete(
      url: string,
      config?: { headers?: Record<string, string> },
    ): Promise<{ status: number; statusText: string; bodyText: string; bytes?: number; headers?: Record<string, string> }>
  }
  /** Host event bus — fire `echo/ping` to trigger the host tool endpoint. */
  emit(event: string, payload?: unknown): unknown
  /** Pages service (spec §5.3, prototype methods). */
  pages: {
    register(entry: {
      pluginId: string
      path: string
      title: string
      order?: number
      icon?: string
      Component?: unknown
    }): unknown
  }
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
type Method = (typeof METHODS)[number]

const browserHalf = function browserHalf(ctx: BrowserCtx, config?: { name?: string }): void {
  const id = config?.name ?? 'echo'
  ctx.logger.info('[echo] browser half active — registering /echo')

  // The page component is defined inside the plugin function so it
  // closes over `ctx` — no window-hack or ctx-prop-drilling required.
  const EchoPage: ComponentType = () => {
    const [method, setMethod] = useState<Method>('GET')
    const [url, setUrl] = useState('https://httpbin.org/get')
    const [headersText, setHeadersText] = useState('{"user-agent":"api-audit-echo/1.0.0"}')
    const [body, setBody] = useState('')
    const [result, setResult] = useState<string | null>(null)
    const [status, setStatus] = useState<number | null>(null)
    const [busy, setBusy] = useState(false)
    const navigate = useNavigate()

    const onSend = async (): Promise<void> => {
      setBusy(true)
      setResult(null)
      setStatus(null)
      try {
        const parsedHeaders = headersText.trim() ? (JSON.parse(headersText) as Record<string, string>) : undefined
        const config = parsedHeaders ? { headers: parsedHeaders } : undefined
        let res: { status: number; statusText: string; bodyText: string; bytes?: number }
        if (method === 'GET') {
          res = await ctx.auditClient.get(url, config)
        } else if (method === 'POST') {
          res = await ctx.auditClient.post(url, body || undefined, config)
        } else if (method === 'PUT') {
          res = await ctx.auditClient.put(url, body || undefined, config)
        } else if (method === 'PATCH') {
          res = await ctx.auditClient.patch(url, body || undefined, config)
        } else {
          res = await ctx.auditClient.delete(url, config)
        }
        setStatus(res.status)
        setResult(`status: ${res.status} ${res.statusText}\nbytes: ${res.bytes ?? res.bodyText.length}\n\n${res.bodyText.slice(0, 2000)}`)
      } catch (err) {
        setResult('Error: ' + (err as Error).message)
      } finally {
        setBusy(false)
      }
    }

    return (
      <div className="page">
        <h1>Echo — 自定义请求测试</h1>
        <div className="muted">本页通过 core 统一 <code>auditClient</code> 发送任意 method/url/headers/body。记录出现在 <Link to="/audit">审计记录</Link>，<code>initiator: "{id}"</code>。</div>

        <section className="card">
          <h2>请求</h2>
          <div className="form">
            <label>
              method{' '}
              <select value={method} onChange={(e) => setMethod((e.target as HTMLSelectElement).value as Method)}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label>
              url{' '}
              <input
                value={url}
                onChange={(e) => setUrl((e.target as HTMLInputElement).value)}
                style={{ width: '100%' }}
              />
            </label>
            <label>
              headers (JSON){' '}
              <textarea
                value={headersText}
                onChange={(e) => setHeadersText((e.target as HTMLTextAreaElement).value)}
                rows={3}
                style={{ width: '100%' }}
              />
            </label>
            <label>
              body{' '}
              <textarea
                value={body}
                onChange={(e) => setBody((e.target as HTMLTextAreaElement).value)}
                rows={3}
                style={{ width: '100%' }}
              />
            </label>
            <div className="form-actions">
              <button onClick={onSend} disabled={busy}>
                {busy ? '请求中…' : '发送'}
              </button>
              <button onClick={() => navigate('/audit')}>跳到审计记录 →</button>
            </div>
          </div>
        </section>

        {result && (
          <section className="card">
            <h2>响应{status !== null ? ` (${status})` : ''}</h2>
            <pre className="result">{result}</pre>
          </section>
        )}
      </div>
    )
  }

  ctx.pages.register({
    pluginId: id,
    path: '/echo',
    title: 'Echo 测试',
    order: 210,
    Component: EchoPage,
  })
}

// cordis reads `inject` off the plugin value; declare our service needs.
;(browserHalf as typeof browserHalf & { inject?: string[] }).inject = ['pages', 'auditClient']

export default browserHalf
