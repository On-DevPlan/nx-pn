import { Component, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { connectRpc, type BrowserRuntimeHandle, type PageRegistration } from '@api-audit/client'
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

  // Subscribe to the Pages service the runtime owns (spec §5.3). Pages are
  // populated both by core built-ins (future work) and by every loaded
  // plugin browser half via ctx.pages.register(…). We render sidebar +
  // routes for any entry whose Component is a function (the web contract).
  const subscribe = useCallback(
    (cb: () => void): (() => void) => {
      const pages = runtime?.pages
      if (!pages) return () => {}
      return pages.subscribe(cb)
    },
    [runtime],
  )
  const getSnapshot = useCallback((): readonly PageRegistration[] => {
    const pages = runtime?.pages
    if (!pages) return EMPTY_PAGES
    return pages.getSnapshot()
  }, [runtime])
  const pageEntries = useSyncExternalStore(subscribe, getSnapshot)
  const pluginPages = useMemo(
    () =>
      pageEntries.filter(
        (p): p is PageRegistration & { Component: ComponentType } =>
          typeof p.Component === 'function',
      ),
    [pageEntries],
  )

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
          {pluginPages.length > 0 && <div className="nav-sep">插件页面</div>}
          {pluginPages.map((p) => (
            <NavLink key={`${p.pluginId}:${p.path}`} to={p.path} className="nav-item">
              {p.title}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <WsBadge runtime={runtime} />
        </div>
      </aside>
      <main className="main">
        <ErrorBoundary>
          <Suspense fallback={<div className="empty">加载中…</div>}>
            <Routes>
              <Route path="/" element={<Navigate to="/audit" replace />} />
              <Route path="/audit" element={<AuditPage runtime={runtime} />} />
              <Route path="/replay" element={<ReplayPage runtime={runtime} />} />
              <Route path="/plugins" element={<PluginsPage />} />
              {pluginPages.map((p) => (
                <Route
                  key={`${p.pluginId}:${p.path}`}
                  path={p.path}
                  element={
                    <PluginPageBoundary title={p.title}>
                      <p.Component />
                    </PluginPageBoundary>
                  }
                />
              ))}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  )
}

/** Stable empty snapshot — keeps useSyncExternalStore happy pre-connect. */
const EMPTY_PAGES: readonly PageRegistration[] = Object.freeze([])

/**
 * Per-plugin error boundary — a faulty page only blanks itself, not the
 * shell. Cheap class component (no hooks); spec §8.1 says a bad half
 * must never wedge the app.
 */
class PluginPageBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error }
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-box">
          <h2>插件页面出错：{this.props.title}</h2>
          <pre>{String(this.state.error?.message ?? this.state.error)}</pre>
          <button onClick={() => this.setState({ error: null })}>重试</button>
        </div>
      )
    }
    return this.props.children
  }
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
