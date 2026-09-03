import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BrowserRuntimeHandle } from '@api-audit/client'
import { fetchAudit } from '@api-audit/client'
import type { AuditRecord } from '@api-audit/client'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** Shared data helper — pages fetch from the host REST API (§6). */
export function useAuditRecords(runtime: BrowserRuntimeHandle | null) {
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const snap = await fetchAudit('')
      setRecords(snap.records)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Subscribe to live pushes: when the WS delivers audit.append, re-pull
    // the REST list so new records appear without manual refresh.
    let unsub: (() => void) | undefined
    if (runtime) {
      unsub = runtime.onSnapshot(() => {
        void refresh()
      })
    }
    const id = window.setInterval(() => void refresh(), 2000)
    return () => {
      window.clearInterval(id)
      unsub?.()
    }
  }, [runtime, refresh])

  return { records, error, refresh }
}

export function AuditPage({ runtime }: { runtime: BrowserRuntimeHandle | null }) {
  const { records, error } = useAuditRecords(runtime)
  const [methodFilter, setMethodFilter] = useState('')
  const [initiatorFilter, setInitiatorFilter] = useState('')
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<AuditRecord | null>(null)

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase()
    return records.filter((r) => {
      if (methodFilter && r.method !== methodFilter) return false
      if (initiatorFilter && !r.initiator.toLowerCase().includes(initiatorFilter.toLowerCase())) return false
      if (q) {
        const hay = `${r.url} ${r.initiator} ${r.statusText}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [records, methodFilter, initiatorFilter, text])

  return (
    <div className="page">
      <h1>审计记录</h1>
      {error && <div className="error-line">加载失败：{error}</div>}

      <div className="filters">
        <select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}>
          <option value="">全部方法</option>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          placeholder="发起方过滤"
          value={initiatorFilter}
          onChange={(e) => setInitiatorFilter(e.target.value)}
        />
        <input placeholder="搜索 URL / 状态" value={text} onChange={(e) => setText(e.target.value)} />
        <span className="count">共 {filtered.length} 条</span>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>发起方</th>
            <th>方法</th>
            <th>URL</th>
            <th>状态</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr>
              <td colSpan={6} className="empty-cell">
                暂无记录
              </td>
            </tr>
          )}
          {filtered.map((r) => (
            <tr key={r.id} onClick={() => setSelected(r)} className="row-click">
              <td>{formatTime(r.ts)}</td>
              <td>
                {r.initiator}
                {r.replayOf !== undefined && <span className="tag replay">重放</span>}
              </td>
              <td>
                <span className={`method ${r.method}`}>{r.method}</span>
              </td>
              <td className="mono" title={r.url}>
                {r.url}
              </td>
              <td>
                <span className={`status ${statusClass(r.status)}`}>{r.status}</span>
              </td>
              <td>{r.durationMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && <DetailDrawer record={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function DetailDrawer({ record, onClose }: { record: AuditRecord; onClose: () => void }) {
  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>
            {record.method} {record.url}
          </h3>
          <button onClick={onClose}>关闭</button>
        </div>
        <div className="drawer-body">
          <InfoRow label="时间" value={formatTime(record.ts)} />
          <InfoRow label="发起方" value={record.initiator} />
          <InfoRow label="状态" value={`${record.status} ${record.statusText}`} />
          <InfoRow label="耗时" value={`${record.durationMs} ms`} />
          {record.replayOf !== undefined && <InfoRow label="重放自" value={`#${record.replayOf}`} />}
          {record.error && <InfoRow label="错误" value={`${record.error.name}: ${record.error.message}`} />}

          <h4>请求头</h4>
          <HeaderTable headers={record.reqHeaders} />
          <h4>请求体</h4>
          <BodyView body={record.reqBody} />

          <h4>响应头</h4>
          <HeaderTable headers={record.resHeaders} />
          <h4>响应体</h4>
          <BodyView body={record.resBody} />
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span>{value}</span>
    </div>
  )
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers)
  if (entries.length === 0) return <div className="muted">（无）</div>
  return (
    <table className="table slim">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td className="mono key">{k}</td>
            <td className="mono">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function BodyView({ body }: { body: { text: string; truncated: boolean; bytes: number } }) {
  if (!body.text) return <div className="muted">（空）</div>
  return (
    <div className="body-view">
      <pre>{body.text}</pre>
      {body.truncated && <div className="muted">已截断（{body.bytes} bytes）</div>}
    </div>
  )
}

function statusClass(status: number): string {
  if (status === 0) return 'err'
  if (status < 300) return 'ok'
  if (status < 400) return 'ok'
  if (status < 500) return 'warn'
  return 'err'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN', { hour12: false })}`
}
