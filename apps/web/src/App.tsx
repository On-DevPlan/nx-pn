import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { connectRpc, type BrowserRuntimeHandle } from '@api-audit/client'
import { AuditPage } from './pages/AuditPage'
import { ReplayPage } from './pages/ReplayPage'
import { PluginsPage } from './pages/PluginsPage'
import { ErrorBoundary } from './ErrorBoundary'

export const HOST_BASE = ''

export function App() {
  const [runtime, setRuntime] = useState<BrowserRuntimeHandle | null>(null)

  useEffect(() => {
    let disposed = false
    let handle: BrowserRuntimeHandle | undefined
    // Boot the browser runtime. The static shell renders immediately;
    // page data flows in over REST once the host answers. connectRpc
    // returns promptly (the WS opens in the background); a synchronous
    // failure just leaves the badge on 连接中….
    void connectRpc({ url: `${location.origin}/ws` })
      .then((h) => {
        if (disposed) {
          h.close()
          return
        }
        handle = h
        setRuntime(h)
      })
      .catch(() => {
        /* no host yet — badge stays 连接中… */
      })
    return () => {
      disposed = true
      handle?.close()
    }
  }, [])

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">API Audit</div>
        <nav>
          <NavLink to="/audit" className="nav-item">
            审计记录
          </NavLink>
          <NavLink to="/replay" className="nav-item">
            API 重放
          </NavLink>
          <NavLink to="/plugins" className="nav-item">
            插件管理
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          <WsBadge runtime={runtime} />
        </div>
      </aside>
      <main className="main">
        <ErrorBoundary>
          <Routes>
            <Route path="/" element={<Navigate to="/audit" replace />} />
            <Route path="/audit" element={<AuditPage runtime={runtime} />} />
            <Route path="/replay" element={<ReplayPage runtime={runtime} />} />
            <Route path="/plugins" element={<PluginsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  )
}

function WsBadge({ runtime }: { runtime: BrowserRuntimeHandle | null }) {
  const [state, setState] = useState<string>('connecting')
  useEffect(() => {
    if (!runtime) return
    const tick = (): void => setState(runtime.status())
    tick()
    const id = window.setInterval(tick, 500)
    return () => window.clearInterval(id)
  }, [runtime])
  const live = state === 'connected'
  return <span className={`ws-badge ${live ? 'on' : ''}`}>{live ? '已连接' : '连接中…'}</span>
}

function NotFound() {
  return (
    <div className="empty">
      <h2>404</h2>
      <p>页面不存在。</p>
    </div>
  )
}
