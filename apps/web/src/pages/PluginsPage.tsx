import { useCallback, useEffect, useState } from 'react'
import type { PluginSummary } from '@api-audit/client'
import { fetchPluginList, stopPlugin, removePlugin, uploadPlugin, installPluginByName, ApiError } from '@api-audit/client'

type PluginState = 'running' | 'stopping' | 'removing' | 'error'

interface PluginRow extends PluginSummary {
  localState: PluginState
  message?: string
}

interface PluginRowState {
  localState: PluginState
  message?: string
}

const PLUGIN_STATE_TEXT: Record<PluginState, string> = {
  running: '运行中',
  stopping: '停止中…',
  removing: '移除中…',
  error: '错误',
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [spec, setSpec] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installMsg, setInstallMsg] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await fetchPluginList('')
      setPlugins((prev) =>
        list.map((p): PluginRow => {
          const old = prev.find((x) => x.pluginRunId === p.pluginRunId)
          if (!old) return { ...p, localState: 'running' }
          const row: PluginRow = { ...p, localState: old.localState }
          if (old.message !== undefined) row.message = old.message
          return row
        }),
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(id)
  }, [refresh])

  async function onInstallByName(): Promise<void> {
    const trimmed = spec.trim()
    if (!trimmed) return
    setInstalling(true)
    setInstallMsg(null)
    setError(null)
    try {
      const r = await installPluginByName('', trimmed)
      setInstallMsg(`已安装 ${trimmed} → ${r.id}@${r.version}（${r.pluginRunId}）`)
      setSpec('')
      await refresh()
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message
      setError(`安装失败：${msg}`)
    } finally {
      setInstalling(false)
    }
  }

  async function onUpload(): Promise<void> {
    if (!file) return
    setUploading(true)
    setUploadResult(null)
    setError(null)
    try {
      const summary = await uploadPlugin('', file, file.name)
      setUploadResult(`上传成功：${summary.id}@${summary.manifest.version}（${summary.pluginRunId}）`)
      setFile(null)
      await refresh()
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message
      setError(`上传失败：${msg}`)
    } finally {
      setUploading(false)
    }
  }

  function patch(runId: string, upd: PluginRowState): void {
    setPlugins((prev) => prev.map((p) => (p.pluginRunId === runId ? { ...p, ...upd } : p)))
  }

  async function onStop(row: PluginRow): Promise<void> {
    patch(row.pluginRunId, { localState: 'stopping' })
    try {
      await stopPlugin('', row.pluginRunId)
      patch(row.pluginRunId, { localState: 'error', message: '已停止' })
    } catch (err) {
      patch(row.pluginRunId, { localState: 'error', message: (err as Error).message })
    }
  }

  async function onRemove(row: PluginRow): Promise<void> {
    patch(row.pluginRunId, { localState: 'removing' })
    try {
      await removePlugin('', row.pluginRunId)
      setPlugins((prev) => prev.filter((p) => p.pluginRunId !== row.pluginRunId))
    } catch (err) {
      patch(row.pluginRunId, { localState: 'error', message: (err as Error).message })
    }
  }

  return (
    <div className="page">
      <h1>插件管理</h1>
      {error && <div className="error-line">{error}</div>}

      <section className="card">
        <h2>按包名安装</h2>
        <div className="upload-row">
          <input
            type="text"
            placeholder="@scope/my-audit-plugin"
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onInstallByName()
            }}
          />
          <button onClick={() => void onInstallByName()} disabled={!spec.trim() || installing}>
            {installing ? '安装中…' : '安装'}
          </button>
        </div>
        {installMsg && <div className="ok-line">{installMsg}</div>}
        <div className="muted">npm 包名（如需指定版本：<span className="mono">pkg@1.2.3</span>），或本地 <span className="mono">file:./插件文件夹</span></div>
      </section>

      <section className="card">
        <h2>或上传 zip</h2>
        <div className="upload-row">
          <input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button onClick={() => void onUpload()} disabled={!file || uploading}>
            {uploading ? '上传中…' : '上传'}
          </button>
        </div>
        {uploadResult && <div className="ok-line">{uploadResult}</div>}
      </section>

      <section className="card">
        <h2>插件列表</h2>
        {plugins.length === 0 && <div className="muted">暂无插件</div>}
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>版本</th>
              <th>标题</th>
              <th>状态</th>
              <th>pluginRunId</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {plugins.map((p) => (
              <tr key={p.pluginRunId}>
                <td className="mono">{p.id}</td>
                <td>{p.manifest.version}</td>
                <td>{p.manifest.title}</td>
                <td>
                  <span className={`status ${p.localState === 'running' ? 'ok' : 'warn'}`}>
                    {PLUGIN_STATE_TEXT[p.localState]}
                  </span>
                  {p.message && <div className="muted">{p.message}</div>}
                </td>
                <td className="mono">{p.pluginRunId}</td>
                <td className="actions">
                  <button
                    className="ghost"
                    disabled={p.localState === 'stopping' || p.localState === 'removing'}
                    onClick={() => void onStop(p)}
                  >
                    停止
                  </button>
                  <button
                    className="ghost danger"
                    disabled={p.localState === 'stopping' || p.localState === 'removing'}
                    onClick={() => void onRemove(p)}
                  >
                    移除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
