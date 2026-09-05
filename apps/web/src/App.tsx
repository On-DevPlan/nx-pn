import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { connectRpc, fetchPluginList, installBrowserHalfFromHost, type BrowserRuntimeHandle, type PageRegistration, type PageRouteEntry } from '@flowot/nx-pn-client'
import type { PluginEvent } from '@flowot/nx-pn-client'
import { AuditPage } from './pages/AuditPage'
import { ReplayPage } from './pages/ReplayPage'
import { PluginsPage } from './pages/PluginsPage'
import { ErrorBoundary } from './ErrorBoundary'

export const HOST_BASE = ''

/** A page entry with a renderable Component (the web contract). */
type RenderablePage = PageRegistration & { Component: ComponentType }

export function App() {
  const [runtime, setRuntime] = useState<BrowserRuntimeHandle | null>(null)

  useEffect(() => {
    let disposed = false
    let handle: BrowserRuntimeHandle | undefined
    // Boot the browser runtime. The static shell renders immediately;
    // page data flows in over REST once the host answers. connectRpc
    // returns promptly (the WS opens in the background); a synchronous
    // failure just leaves the badge on 连接中….
    void connectRpc({ url: `${window.location.origin}/ws` })
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

  // Install browser halves for every plugin currently loaded on the host.
  // The WS snapshot path covers live pushes, but the static shell must
  // also repopulate plugin pages on cold start (page refresh) — the host
  // doesn't replay browser-half.load frames, only the manifest. We fetch
  // the plugin list over REST, install each half, and subscribe to
  // snapshot changes so live uploads/restarts refresh the page list too.
  const installedRunIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!runtime) return
    const rt = runtime
    let cancelled = false

    async function installPlugin(id: string, pluginRunId: string): Promise<void> {
      try {
        if (cancelled) return
        if (installedRunIdsRef.current.has(pluginRunId)) return
        // Idempotency check via the shared Pages registry — if any path
        // (WS reconcile, prior install, etc.) already registered a page
        // for this plugin, skip and remember the runId so we don't retry.
        const existing = rt.pages.getSnapshot().find((e) => e.pluginId === id)
        if (existing) {
          installedRunIdsRef.current.add(pluginRunId)
          return
        }
        await installBrowserHalfFromHost(rt, { id })
        installedRunIdsRef.current.add(pluginRunId)
      } catch (err) {
        // isolate — a bad half must not kill the UI
        const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
        console.warn(`[plugin-sync] failed to install browser half for ${id} (${pluginRunId}): ${msg}`)
      }
    }

    async function bootInstall(): Promise<void> {
      let plugins: Awaited<ReturnType<typeof fetchPluginList>>
      try {
        plugins = await fetchPluginList(HOST_BASE)
      } catch {
        return
      }
      if (cancelled) return
      for (const p of plugins) {
        if (!p.manifest.halves.browser?.entry) continue
        void installPlugin(p.id, p.pluginRunId)
      }
    }

    void bootInstall()

    // Subscribe to snapshot changes so live uploads/restarts refresh pages
    // even if the WS browser-half.load frame was missed (page hidden,
    // reconnect, etc.).
    const unsub = rt.onSnapshot((snap) => {
      for (const p of snap.plugins) {
        if (!p.manifest.halves.browser?.entry) continue
        void installPlugin(p.id, p.pluginRunId)
      }
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [runtime])

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
        (p): p is RenderablePage => typeof p.Component === 'function',
      ),
    [pageEntries],
  )

  // Split by layout: flat pages stay inside <main> (sidebar visible);
  // fullscreen pages claim the whole viewport with plugin-owned sub-routes.
  const shellPages = useMemo(
    () => pluginPages.filter((p) => p.layout !== 'fullscreen'),
    [pluginPages],
  )
  const fullscreenPages = useMemo(
    () => pluginPages.filter((p) => p.layout === 'fullscreen'),
    [pluginPages],
  )

  // Does the CURRENT location fall under any fullscreen page's prefix?
  // useLocation() re-renders this component on every navigation, so the
  // check is always fresh — plain prefix matching, no hook gymnastics.
  const location = useLocation()
  const fullscreenActive = useMemo(
    () => fullscreenPages.some((p) => matchesFullscreenPrefix(location.pathname, p.path)),
    [fullscreenPages, location.pathname],
  )

  return (
    <ShellLayout
      fullscreenActive={fullscreenActive}
      shellPages={shellPages}
      fullscreenPages={fullscreenPages}
      runtime={runtime}
    >
      <Routes>
        <Route path="/" element={<Navigate to="/audit" replace />} />
        <Route path="/audit" element={<AuditPage runtime={runtime} />} />
        <Route path="/replay" element={<ReplayPage runtime={runtime} />} />
        <Route path="/plugins" element={<PluginsPage runtime={runtime} />} />
        {shellPages.map((p) => (
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
        {fullscreenPages.map((p) => (
          <Route
            key={`${p.pluginId}:${p.path}`}
            path={`${p.path}/*`}
            element={<FullscreenSlot page={p} />}
          />
        ))}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ShellLayout>
  )
}

/**
 * Sidebar + brand, hidden entirely while a fullscreen page is active.
 * The layout decision is structural: the fullscreen plugin fills 100vw
 * because the sidebar is simply not rendered for its subtree. Navigating
 * to /audit (or any shell route) brings the chrome back.
 */
function ShellLayout({
  fullscreenActive,
  shellPages,
  fullscreenPages,
  runtime,
  children,
}: {
  fullscreenActive: boolean
  shellPages: readonly RenderablePage[]
  fullscreenPages: readonly RenderablePage[]
  runtime: BrowserRuntimeHandle | null
  children: ReactNode
}) {
  if (fullscreenActive) {
    // Fullscreen subtree — the <Routes> above resolves the active plugin's
    // FullscreenSlot (its own local routes render the viewport). The plugin
    // owns the whole viewport (no sidebar/brand), so we overlay a small
    // floating 返回首页 button as a global escape hatch back to /audit.
    return (
      <>
        {children}
        <BackToHomeFab />
      </>
    )
  }
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">API Audit</div>
        <nav>
          <div className="bw-nav">
            <NavLink to="/audit" className="nav-item">
              审计记录
            </NavLink>
            <NavLink to="/replay" className="nav-item">
              API 重放
            </NavLink>
            <NavLink to="/plugins" className="nav-item">
              插件管理
            </NavLink>
          </div>
          {fullscreenPages.length > 0 && <div className="nav-sep">插件页面（全屏）</div>}
          {fullscreenPages.map((p) => (
            <NavLink key={`${p.pluginId}:${p.path}`} to={p.path} className="nav-item">
              {p.title}
            </NavLink>
          ))}
          {shellPages.length > 0 && <div className="nav-sep">插件页面</div>}
          {shellPages.map((p) => (
            <NavLink key={`${p.pluginId}:${p.path}`} to={p.path} className="nav-item">
              {p.title}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <DebugPanel runtime={runtime} />
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  )
}

/**
 * One route element per fullscreen page: the boundary wraps the plugin's
 * OWN local <Routes> built from `page.routes`. `page.Component` (if
 * provided) becomes the `*` fallback inside the plugin's local routing.
 */
function FullscreenSlot({ page }: { page: RenderablePage }) {
  return (
    <div className="fullscreen-root">
      <PluginPageBoundary title={page.title} fullscreen>
        <PluginLocalRoutes routes={page.routes ?? []} fallback={page.Component} />
      </PluginPageBoundary>
    </div>
  )
}

/**
 * Map a fullscreen page's `routes` onto react-router v6 nested routes,
 * all inside ONE <Routes>. A sub-route path of '/' becomes '' (v6 nested
 * matching: the '' child handles the bare prefix); other leading slashes
 * are stripped — the paths are RELATIVE to the page prefix (the parent
 * Route already carries `<prefix>/*`). `fallback` (the page's flat
 * Component) becomes the `*` catch-all inside the plugin's local routing
 * so undeclared sub-paths still render something sane.
 */
function PluginLocalRoutes({
  routes,
  fallback,
}: {
  routes: PageRouteEntry[]
  fallback: unknown
}) {
  return (
    <Routes>
      {routes.map((r, i) => {
        const rr = r.path === '/' ? '' : r.path.replace(/^\//, '')
        return <Route key={`${r.path}:${i}`} path={rr} element={<RouteView Component={r.Component} />} />
      })}
      {fallback !== undefined && <Route path="*" element={<RouteView Component={fallback} />} />}
    </Routes>
  )
}

/** Narrow a registration Component (unknown) to a renderable function. */
function RouteView({ Component }: { Component: unknown }) {
  if (typeof Component === 'function') {
    const C = Component as ComponentType
    return <C />
  }
  return null
}

/** `<prefix>` exactly, or `<prefix>/…` (prefix itself starts with '/'). */
function matchesFullscreenPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/' || prefix === '') return true
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** Stable empty snapshot — keeps useSyncExternalStore happy pre-connect. */
const EMPTY_PAGES: readonly PageRegistration[] = Object.freeze([])

/**
 * Per-plugin error boundary — a faulty page only blanks itself, not the
 * shell. Cheap class component (no hooks); spec §8.1 says a bad half
 * must never wedge the app. The `fullscreen` variant renders the error
 * box full-viewport (there is no shell chrome around it) with a
 * 返回壳 escape hatch back to /audit.
 */
class PluginPageBoundary extends Component<{ title: string; fullscreen?: boolean; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error }
  }

  override render(): ReactNode {
    if (this.state.error) {
      const box = (
        <div className="error-box">
          <h2>插件页面出错：{this.props.title}</h2>
          <pre>{String(this.state.error?.message ?? this.state.error)}</pre>
          <button onClick={() => this.setState({ error: null })}>重试</button>
          {this.props.fullscreen ? <BackToShell /> : null}
        </div>
      )
      return this.props.fullscreen ? <div className="fullscreen-root">{box}</div> : box
    }
    return this.props.children
  }
}

/** Escape hatch rendered on fullscreen error boxes (needs router context). */
function BackToShell() {
  const navigate = useNavigate()
  return <button onClick={() => navigate('/audit')}>返回壳</button>
}

/**
 * Global floating "返回首页" button, shown only while a fullscreen plugin
 * page owns the viewport (sidebar hidden). Some fullscreen plugins don't
 * ship their own escape hatch, so this guarantees a one-click way back to
 * the shell's home page (/audit).
 */
function BackToHomeFab() {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      className="back-home-fab"
      title="返回首页（/audit）"
      aria-label="返回首页"
      onClick={() => navigate('/audit')}
    >
      <span className="back-home-fab-icon" aria-hidden="true">
        ⌂
      </span>
      <span className="back-home-fab-text">返回首页</span>
    </button>
  )
}

/**
 * Sidebar footer: WS connection state + a collapsible event log (plugin
 * lifecycle events streamed over `plugin.changed`). Collapsed by default
 * — it's a debugging surface, not chrome.
 */
function DebugPanel({ runtime }: { runtime: BrowserRuntimeHandle | null }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<string>('connecting')
  const [events, setEvents] = useState<PluginEvent[]>([])
  const [pluginSeq, setPluginSeq] = useState(0)

  useEffect(() => {
    if (!runtime) return
    const tick = (): void => setState(runtime.status())
    tick()
    const id = window.setInterval(tick, 500)
    return () => window.clearInterval(id)
  }, [runtime])

  useEffect(() => {
    if (!runtime) return
    const unsub = runtime.onPluginChanged((snap) => {
      if ((snap.pluginSeq ?? 0) > pluginSeq) {
        setPluginSeq(snap.pluginSeq ?? 0)
        setEvents(snap.pluginEvents ?? [])
      }
    })
    return unsub
  }, [runtime, pluginSeq])

  const live = state === 'connected'

  return (
    <div className="debug-panel">
      <span className={`ws-badge ${live ? 'on' : ''}`}>{live ? '已连接' : '连接中…'}</span>
      <button
        type="button"
        className="debug-toggle"
        onClick={() => setOpen((v) => !v)}
        title="插件加载/启动/停止事件"
      >
        {open ? '▼' : '▶'} 插件事件 ({events.length})
      </button>
      {open && (
        <div className="debug-events">
          {events.length === 0 ? (
            <div className="muted" style={{ padding: '6px 4px' }}>暂无</div>
          ) : (
            <ul>
              {[...events].reverse().slice(0, 10).map((e) => (
                <li key={`${e.seq}:${e.pluginRunId}`}>
                  <span className="debug-time mono">{formatDebugTime(e.ts)}</span>
                  <span className={`event-type event-${e.type}`}>{DEBUG_EVENT_LABEL[e.type] ?? e.type}</span>
                  <span className="debug-id mono">{e.id}</span>
                  <span className="debug-rid mono">{e.pluginRunId}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function formatDebugTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

const DEBUG_EVENT_LABEL: Record<string, string> = {
  upload: '上传',
  install: '安装',
  start: '启动',
  stop: '停止',
  remove: '移除',
  uninstall: '卸载',
}

function NotFound() {
  return (
    <div className="empty">
      <h2>404</h2>
      <p>页面不存在。</p>
    </div>
  )
}
