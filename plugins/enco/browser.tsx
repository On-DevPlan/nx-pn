/**
 * enco — browser half for encoding/decoding utility.
 */

import { useState } from 'react'

interface BrowserCtx {
  logger: { info(m: string): void }
  pages: {
    register(entry: { pluginId: string; path: string; title: string; order?: number; Component?: unknown }): unknown
  }
  hostCall: {
    hostCall(event: string, payload?: unknown): Promise<unknown>
  }
}

const browserHalf = function browserHalf(ctx: BrowserCtx, config?: { name?: string }): void {
  const id = config?.name ?? 'enco'
  ctx.logger.info(`[${id}] browser half active`)

  const PageComponent = () => {
    const [inputText, setInputText] = useState('')
    const [outputText, setOutputText] = useState('')
    const [encoding, setEncoding] = useState('base64')
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    const doCall = async (action: 'encode' | 'decode') => {
      setLoading(true)
      setError(null)
      try {
        const res = await ctx.hostCall.hostCall(`enco/${action}`, { text: inputText, encoding }) as { ok: boolean; data?: { encoded?: string; decoded?: string }; error?: string }
        if (res.ok && res.data) {
          setOutputText(res.data.encoded ?? res.data.decoded ?? '')
        } else {
          setError(res.error ?? `${action} failed`)
        }
      } catch (err) { setError((err as Error).message) }
      finally { setLoading(false) }
    }

    return (
      <div className="page">
        <h1>Encoding/Decoding Utility</h1>
        <div className="muted">Plugin enco browser half.</div>
        <section className="card">
          <h2>Input</h2>
          <div className="form-group"><label>Text</label><textarea value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="Enter text..." rows={4} /></div>
          <div className="form-group">
            <label>Encoding</label>
            <select value={encoding} onChange={(e) => setEncoding(e.target.value)}>
              <option value="base64">Base64</option>
              <option value="url">URL (percent-encoding)</option>
              <option value="hex">Hexadecimal</option>
            </select>
          </div>
          <div className="form-actions">
            <button onClick={() => doCall('encode')} disabled={loading || !inputText}>{loading ? 'Processing...' : 'Encode'}</button>
            <button onClick={() => doCall('decode')} disabled={loading || !inputText}>{loading ? 'Processing...' : 'Decode'}</button>
          </div>
        </section>
        <section className="card">
          <h2>Output</h2>
          <textarea value={outputText} readOnly placeholder="Result will appear here..." rows={4} />
          {outputText && <div className="form-actions"><button onClick={() => navigator.clipboard.writeText(outputText)}>Copy to Clipboard</button></div>}
        </section>
        {error && <section className="card error"><h2>Error</h2><p>{error}</p></section>}
      </div>
    )
  }

  ctx.pages.register({ pluginId: id, path: '/' + id, title: 'Encode/Decode', order: 200, Component: PageComponent })
}

;(browserHalf as typeof browserHalf & { inject?: string[] }).inject = ['pages']
export default browserHalf
