import { useEffect, useMemo, useState } from 'react'
import type { AuditRecord, BrowserRuntimeHandle } from '@flowot/nx-pn-client'
import { fetchAudit, fetchReplay } from '@flowot/nx-pn-client'

const NON_IDEMPOTENT = ['POST', 'PUT', 'PATCH', 'DELETE']
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

interface ReplayOutcome {
  original: AuditRecord
  replayed: {
    status: number
    statusText: string
    durationMs: number
    bodyText: string
    headers: Record<string, string>
  }
  error?: string
}

export function ReplayPage({ runtime }: { runtime: BrowserRuntimeHandle | null }) {
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [recordId, setRecordId] = useState<number | ''>('')
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [body, setBody] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<ReplayOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Load the audit list (reuse polling so new records show up).
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const snap = await fetchAudit('')
        if (!cancelled) setRecords(snap.records)
      } catch {
        // host not up — leave list empty
      }
    }
    void load()
    const id = window.setInterval(() => void load(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const selected = useMemo(
    () => records.find((r) => r.id === recordId) ?? null,
    [records, recordId],
  )

  // When a record is selected, populate the editable form.
  useEffect(() => {
    if (!selected) return
    setMethod(selected.method)
    setUrl(selected.url)
    setHeadersText(formatHeaders(selected.reqHeaders))
    setBody(selected.reqBody.text)
  }, [selected])

  const hasCredentialHeaders = useMemo(() => {
    if (!selected) return false
    const names = Object.keys(selected.reqHeaders)
    return names.some((n) => /^(authorization|cookie|x-api-key|proxy-authorization|x-auth-token)$/i.test(n))
  }, [selected])

  const parsedHeaders = useMemo(() => parseHeaders(headersText), [headersText])

  const canReplay = recordId !== '' && url.trim().length > 0
  const isNonIdempotent = NON_IDEMPOTENT.includes(method)

  async function runReplay(): Promise<void> {
    if (recordId === '') return
    setBusy(true)
    setError(null)
    try {
      const res = await fetchReplay('', {
        recordId,
        overrides: { method: method as AuditRecord['method'], url, headers: parsedHeaders, body },
      })
      setOutcome({
        original: selected!,
        replayed: {
          status: res.status,
          statusText: res.statusText,
          durationMs: 0, // duration not in AuditResponse — use body only
          bodyText: res.bodyText,
          headers: res.headers,
        },
      })
      setConfirming(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function onReplayClick(): void {
    if (isNonIdempotent) {
      setConfirming(true)
      return
    }
    void runReplay()
  }

  return (
    <div className="page">
      <h1>API 重放</h1>
      <div className="replay-grid">
        <section className="card">
          <h2>1. 选择记录</h2>
          <select value={recordId} onChange={(e) => setRecordId(Number(e.target.value) || '')}>
            <option value="">请选择…</option>
            {[...records].reverse().map((r) => (
              <option key={r.id} value={r.id}>
                #{r.id} {r.method} {r.url}
              </option>
            ))}
          </select>

          {hasCredentialHeaders && (
            <div className="warn-box">
              此请求包含凭证，重放将使用当前凭证服务的值。
            </div>
          )}

          <h2>2. 编辑请求</h2>
          <div className="form-row">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input className="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL" />
          </div>
          <label className="field-label">请求头 (每行 `Key: value`)</label>
          <textarea value={headersText} onChange={(e) => setHeadersText(e.target.value)} rows={4} className="mono" />
          <label className="field-label">请求体</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} className="mono" />

          {selected?.reqBody.truncated && (
            <div className="muted">原始请求体已截断，重放将使用截断版本。</div>
          )}

          <div className="form-actions">
            <button onClick={onReplayClick} disabled={!canReplay || busy}>
              {busy ? '重放中…' : '重放'}
            </button>
          </div>
          {error && <div className="error-line">{error}</div>}
        </section>

        <section className="card">
          <h2>3. 对比</h2>
          {!outcome && <div className="muted">选择记录并点击“重放”后在此对比。</div>}
          {outcome && <CompareView outcome={outcome} />}
        </section>
      </div>

      {confirming && selected && (
        <div className="drawer-mask" onClick={() => setConfirming(false)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <h3>确认重放非幂等请求</h3>
            <div className="mono confirm-detail">
              <div>
                {method} {url}
              </div>
              <div>发起方：{selected.initiator}</div>
              <pre>{body.slice(0, 1000)}</pre>
            </div>
            <div className="form-actions">
              <button className="ghost" onClick={() => setConfirming(false)}>
                取消
              </button>
              <button onClick={() => void runReplay()} disabled={busy}>
                确认重放
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CompareView({ outcome }: { outcome: ReplayOutcome }) {
  const { original, replayed } = outcome
  return (
    <div className="compare">
      <div className="compare-col">
        <h3>原始记录</h3>
        <div className="compare-item">
          <span>状态</span>
          <b>
            {original.status} {original.statusText}
          </b>
        </div>
        <div className="compare-item">
          <span>耗时</span>
          <b>{original.durationMs} ms</b>
        </div>
        <pre className="body-view">{original.resBody.text || '（空）'}</pre>
      </div>
      <div className="compare-col">
        <h3>重放结果</h3>
        <div className="compare-item">
          <span>状态</span>
          <b>
            {replayed.status} {replayed.statusText}
          </b>
        </div>
        <div className="compare-item">
          <span>耗时</span>
          <b>{replayed.durationMs ? `${replayed.durationMs} ms` : '—'}</b>
        </div>
        <pre className="body-view">{replayed.bodyText || '（空）'}</pre>
      </div>
    </div>
  )
}

function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}
