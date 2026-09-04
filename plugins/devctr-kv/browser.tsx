/**
 * devctr-kv — browser half (FULLSCREEN plugin demo).
 *
 * Provides a full management UI for the DevCtr platform, claiming the
 * whole viewport (`layout: 'fullscreen'`):
 *   - 概览 `/`        — dashboard: stats cards + one audited GET button
 *   - 工作组 `/groups` — group management (CRUD, members, invitations)
 *   - 键管理 `/keys`   — KV management (CRUD, versions, visibility, shares)
 *   - 用户 `/user`     — login/logout + default group
 *
 * Sub-routes are plugin-OWNED: the half registers `routes[]` with local
 * Components and the web shell mounts them under `/devctr-kv/*` — the
 * sidebar is hidden and this file's own <Routes> governs every sub-path.
 * A top bar (本页局部导航) links the views + a 返回壳 link back to /audit.
 *
 * All network calls go through host event handlers (`devctr-kv/*`) via
 * ctx.hostCall, which rides the WS `tool.invoke` op → host cordis
 * `serial` dispatch → the host half's registered handler (JWT + audit
 * attribution live there); the 概览 view also fires one audited GET
 * directly via ctx.auditClient to prove the plugin API works from inside
 * a fullscreen view.
 */

import { useState, useEffect, type ComponentType, type ReactNode } from 'react'
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom'

// ── Types ──────────────────────────────────────────────────────────

interface ApiResult {
  ok: boolean
  data?: unknown
  error?: string
  status?: number
}

interface BrowserCtx {
  logger: { info(message: string): void; warn(message: string): void }
  /** Browser→host tool-event bridge: call a host-half event handler
   * (`<plugin>/<action>`, registered via ctx.on on the HOST context). */
  hostCall: {
    hostCall(event: string, payload?: unknown): Promise<unknown>
  }
  auditClient: {
    get(
      url: string,
      config?: { headers?: Record<string, string> },
    ): Promise<{ status: number; statusText: string; bodyText: string; bytes?: number }>
    post(
      url: string,
      body?: string,
      config?: { headers?: Record<string, string> },
    ): Promise<{ status: number; statusText: string; bodyText: string; bytes?: number }>
    put(
      url: string,
      body?: string,
      config?: { headers?: Record<string, string> },
    ): Promise<{ status: number; statusText: string; bodyText: string; bytes?: number }>
    patch(
      url: string,
      body?: string,
      config?: { headers?: Record<string, string> },
    ): Promise<{ status: number; statusText: string; bodyText: string; bytes?: number }>
    delete(
      url: string,
      config?: { headers?: Record<string, string> },
    ): Promise<{ status: number; statusText: string; bodyText: string; bytes?: number }>
  }
  pages: {
    register(entry: {
      pluginId: string
      path: string
      title: string
      order?: number
      icon?: string
      layout?: 'shell' | 'fullscreen'
      routes?: { path: string; Component: unknown }[]
      Component?: unknown
    }): unknown
  }
}

interface UserInfo {
  id: number
  email: string
  username: string
  nickname: string
  invitationCode: string
}

interface GroupInfo {
  id: number
  name: string
  description: string
  ownerId: number
  myRole: string
  memberCount: number
  createdAt: string
  updatedAt: string
}

interface MemberInfo {
  userId: number
  email: string
  nickname: string
  role: string
  joinedAt: string
}

interface InvitationInfo {
  id: number
  groupId: number
  groupName: string
  inviterId: number
  inviteeEmail: string
  role: string
  code: string
  maxUses: number
  usedCount: number
  expiresAt: string
  status: string
  createdAt: string
}

interface KvItem {
  key: string
  value: string
  metadata: Record<string, unknown>
  expires_at: string
  tags: string[]
  groupId: number
  groupName: string
  myRole: string
  visibility?: string
  currentVersion?: number
}

interface KvVersion {
  version_no: number
  value_len: number
  replaced_at: string
}

interface ShareInfo {
  code: string
  kvId: number
  maxUses: number
  usedCount: number
  remaining: number
  expiresAt: string
  status: string
  createdAt: string
  accessUrl: string
}

interface TagInfo {
  tag: string
  count: number
}

// ── Plugin ─────────────────────────────────────────────────────────

const browserHalf = function browserHalf(ctx: BrowserCtx, config?: { name?: string }): void {
  const id = config?.name ?? 'devctr-kv'
  ctx.logger.info(`[${id}] browser half active — registering /devctr-kv (fullscreen)`)

  // Helper: call a host event and unwrap the result.
  //
  // Wire: `ctx.hostCall.hostCall(event, payload)` rides the WS
  // `tool.invoke` op; the host dispatches the event on its cordis
  // context (`serial` mode) and replies with the host half's ApiResult
  // — including its structured errors (e.g. the backend's 登录失败)
  // and the no-handler degradation. cordis's service convention mirrors
  // `ctx.auditClient.get(url)` and `ctx.pages.register(entry)`.
  async function call(action: string, payload?: Record<string, unknown>): Promise<ApiResult> {
    try {
      const r = await ctx.hostCall.hostCall(`devctr-kv/${action}`, payload ?? {})
      if (r === undefined || r === null) return { ok: false, error: `${action}：无返回` }
      return r as ApiResult
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  // ── Shared UI primitives ────────────────────────────────────────

  function ErrorBanner({ error }: { error: string | null }): ReactNode {
    if (!error) return null
    return <div style={{ color: '#c0392b', background: '#fdf0ef', padding: '8px 12px', borderRadius: 4, marginBottom: 12 }}>{error}</div>
  }

  function SuccessBanner({ msg }: { msg: string | null }): ReactNode {
    if (!msg) return null
    return <div style={{ color: '#1e8449', background: '#eafaf1', padding: '8px 12px', borderRadius: 4, marginBottom: 12 }}>{msg}</div>
  }

  function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
    return (
      <label style={{ display: 'block', marginBottom: 10 }}>
        <span style={{ display: 'block', fontSize: 13, color: '#555', marginBottom: 4 }}>{label}</span>
        {children}
      </label>
    )
  }

  const inputStyle: React.CSSProperties = { width: '100%', padding: '6px 10px', border: '1px solid #ccc', borderRadius: 4, fontSize: 14 }
  const btnStyle: React.CSSProperties = { padding: '6px 16px', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 14, background: '#2d72d9', color: '#fff' }
  const btnSecondary: React.CSSProperties = { ...btnStyle, background: '#6c757d' }
  const btnDanger: React.CSSProperties = { ...btnStyle, background: '#c0392b' }
  const btnSmall: React.CSSProperties = { padding: '3px 10px', fontSize: 12, borderRadius: 3, border: 'none', cursor: 'pointer', background: '#eee', color: '#333' }

  // ── Auth store (shared across the plugin's local views) ─────────
  // Each registered route Component is self-sufficient (top bar + auth
  // gate included), so they need one shared login flag. Module-closure
  // store + manual subscribe keeps it dependency-free.

  const auth = {
    loggedIn: false,
    listeners: new Set<() => void>(),
    set(v: boolean): void {
      this.loggedIn = v
      for (const l of [...this.listeners]) {
        try {
          l()
        } catch {
          // isolated — a bad subscriber must not break the store
        }
      }
    },
    subscribe(l: () => void): () => void {
      this.listeners.add(l)
      return () => {
        this.listeners.delete(l)
      }
    },
  }

  /** Hook: reactive auth.loggedIn for local views. */
  function useLoggedIn(): boolean {
    const [loggedIn, setLoggedIn] = useState(auth.loggedIn)
    useEffect(() => auth.subscribe(() => setLoggedIn(auth.loggedIn)), [])
    return loggedIn
  }

  // One boot check per half load — flips the top bar + gates to the
  // real login state without waiting for a view to mount.
  void call('userInfo')
    .then((r) => auth.set(r.ok))
    .catch(() => auth.set(false))

  // ── Fullscreen top bar (plugin-owned local nav) ─────────────────

  const TopBar: ComponentType = () => {
    const loggedIn = useLoggedIn()
    const navigate = useNavigate()
    const linkStyle = (isActive: boolean): React.CSSProperties => ({
      padding: '6px 14px',
      borderRadius: 4,
      textDecoration: 'none',
      fontSize: 14,
      color: isActive ? '#2d72d9' : '#555',
      background: isActive ? '#e8f0fe' : 'transparent',
      fontWeight: isActive ? 700 : 400,
    })
    return (
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          padding: '12px 28px',
          borderBottom: '1px solid #e2e4e9',
          background: '#ffffff',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <strong style={{ fontSize: 16 }}>DevCtr KV 控制台</strong>
        <nav style={{ display: 'flex', gap: 4 }}>
          <NavLink to="/devctr-kv" end style={({ isActive }) => linkStyle(isActive)}>
            概览
          </NavLink>
          {loggedIn && (
            <>
              <NavLink to="/devctr-kv/groups" style={({ isActive }) => linkStyle(isActive)}>
                工作组
              </NavLink>
              <NavLink to="/devctr-kv/keys" style={({ isActive }) => linkStyle(isActive)}>
                键管理
              </NavLink>
              <NavLink to="/devctr-kv/user" style={({ isActive }) => linkStyle(isActive)}>
                用户
              </NavLink>
            </>
          )}
        </nav>
        <span style={{ flex: 1 }} />
        <button style={btnSmall} onClick={() => navigate('/audit')}>返回壳</button>
      </header>
    )
  }

  // ── 概览 Dashboard (/) ───────────────────────────────────────────

  const Dashboard: ComponentType<{ onLoginNeeded: () => void }> = ({ onLoginNeeded }) => {
    const loggedIn = useLoggedIn()
    const [groups, setGroups] = useState<GroupInfo[]>([])
    const [stats, setStats] = useState<{ kvTotal: number; shareCount: number } | null>(null)
    const [probe, setProbe] = useState<string | null>(null)
    const [probeBusy, setProbeBusy] = useState(false)
    const navigate = useNavigate()

    useEffect(() => {
      if (!loggedIn) return
      void (async () => {
        const [g, kv, shares] = await Promise.all([call('listGroups'), call('listKv', { limit: 1 }), call('listShares', { limit: 1 })])
        if (g.ok && g.data) setGroups((g.data as { groups: GroupInfo[] }).groups || [])
        const kvTotal = kv.ok && kv.data ? ((kv.data as { total: number }).total ?? 0) : 0
        const shareCount = shares.ok && shares.data ? ((shares.data as { total?: number }).total ?? (shares.data as { items?: unknown[] }).items?.length ?? 0) : 0
        setStats({ kvTotal, shareCount })
      })()
    }, [loggedIn])

    // One audited GET straight through ctx.auditClient — proves the
    // plugin API works from a fullscreen view (record lands on /audit
    // with initiator: 'devctr-kv').
    const runProbe = async (): Promise<void> => {
      setProbeBusy(true)
      setProbe(null)
      try {
        const res = await ctx.auditClient.get('https://httpbin.org/get', { headers: { 'user-agent': 'api-audit-devctr-kv/1.0.0' } })
        setProbe(`status: ${res.status} ${res.statusText}\nbytes: ${res.bytes ?? res.bodyText.length}\n\n${res.bodyText.slice(0, 500)}`)
      } catch (err) {
        setProbe('Error: ' + (err as Error).message)
      } finally {
        setProbeBusy(false)
      }
    }

    if (!loggedIn) {
      return (
        <div className="page">
          <h1>概览</h1>
          <div className="muted">未登录 DevCtr。概览数据需要登录后才能拉取；你仍可以在下方直接试一次被审计的 GET 请求。</div>
          <section className="card" style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
            <button style={btnStyle} onClick={onLoginNeeded}>去登录 →</button>
            <button style={btnSecondary} onClick={() => void runProbe()} disabled={probeBusy}>
              {probeBusy ? '请求中…' : '发一次审计 GET (httpbin.org/get)'}
            </button>
          </section>
          {probe && (
            <section className="card">
              <h2>审计响应</h2>
              <pre className="result" style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{probe}</pre>
            </section>
          )}
        </div>
      )
    }

    return (
      <div className="page">
        <h1>概览</h1>
        <div className="muted">DevCtr 控制台总览。本页是插件自有的全屏局部路由（<code>/devctr-kv</code> → <code>/</code>），壳侧栏不渲染。</div>
        <div style={{ display: 'flex', gap: 16, margin: '16px 0', flexWrap: 'wrap' }}>
          <section className="card" style={{ flex: '1 1 200px', margin: 0 }}>
            <div style={{ fontSize: 13, color: '#888' }}>我的工作组</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>{groups.length}</div>
          </section>
          <section className="card" style={{ flex: '1 1 200px', margin: 0 }}>
            <div style={{ fontSize: 13, color: '#888' }}>KV 条目（默认组）</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>{stats?.kvTotal ?? '—'}</div>
          </section>
          <section className="card" style={{ flex: '1 1 200px', margin: 0 }}>
            <div style={{ fontSize: 13, color: '#888' }}>分享数</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>{stats?.shareCount ?? '—'}</div>
          </section>
        </div>

        <section className="card">
          <h2>快捷入口</h2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button style={btnStyle} onClick={() => navigate('/devctr-kv/keys')}>键管理 →</button>
            <button style={btnSecondary} onClick={() => navigate('/devctr-kv/groups')}>工作组 →</button>
            <button style={btnSecondary} onClick={() => navigate('/audit')}>查看审计记录 →</button>
          </div>
        </section>

        <section className="card">
          <h2>插件 API 直连（审计验证）</h2>
          <p className="muted">从全屏视图直接调用 <code>ctx.auditClient.get('https://httpbin.org/get')</code>，记录会以 <code>initiator: "{id}"</code> 出现在审计页。</p>
          <button style={btnStyle} onClick={() => void runProbe()} disabled={probeBusy}>
            {probeBusy ? '请求中…' : '发一次审计 GET'}
          </button>
          {probe && (
            <pre className="result" style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', marginTop: 12, background: '#10131a', color: '#d8dee9', padding: 10, borderRadius: 4 }}>{probe}</pre>
          )}
        </section>

        <div className="muted" style={{ marginTop: 12 }}>
          本插件使用 <Link to="/audit">审计记录</Link> 页面查看所有出站请求。
        </div>
      </div>
    )
  }

  // ── Login Form (用户 route, logged-out) ─────────────────────────

  const LoginForm: ComponentType<{ onLogin: () => void }> = ({ onLogin }) => {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const submit = async () => {
      setBusy(true)
      setError(null)
      const r = await call('login', { email, password })
      setBusy(false)
      if (r.ok) {
        onLogin()
      } else {
        setError(r.error || '登录失败')
      }
    }

    return (
      <div className="page">
        <h1>DevCtr 登录</h1>
        <div className="muted">使用邮箱和密码登录 DevCtr 平台。登录后可管理工作组和 KV 数据。</div>
        <section className="card" style={{ maxWidth: 420 }}>
          <ErrorBanner error={error} />
          <Field label="邮箱">
            <input style={inputStyle} value={email} onChange={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="you@example.com" />
          </Field>
          <Field label="密码">
            <input style={inputStyle} type="password" value={password} onChange={(e) => setPassword((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
          </Field>
          <div className="form-actions">
            <button style={btnStyle} onClick={submit} disabled={busy}>{busy ? '登录中…' : '登录'}</button>
          </div>
        </section>
      </div>
    )
  }

  // ── User Panel (/user) ──────────────────────────────────────────
  // Logged-out it IS the login form; after login it shows profile +
  // default-group management. Both variants share the 登录 state via the
  // auth store (set by LoginForm's submit and logout).

  const UserPanel: ComponentType = () => {
    const loggedIn = useLoggedIn()
    if (!loggedIn) return <LoginForm onLogin={() => auth.set(true)} />
    return <UserPanelInner onLogout={() => auth.set(false)} />
  }

  const UserPanelInner: ComponentType<{ onLogout: () => void }> = ({ onLogout }) => {
    const [user, setUser] = useState<UserInfo | null>(null)
    const [defaultGroup, setDefaultGroup] = useState<{ groupId: number; name: string; myRole: string } | null>(null)
    const [groups, setGroups] = useState<GroupInfo[]>([])
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    const refresh = async () => {
      const [u, g, dg] = await Promise.all([call('userInfo'), call('listGroups'), call('getDefaultGroup')])
      if (u.ok && u.data) setUser(u.data as UserInfo)
      else setError(u.error || '获取用户信息失败')
      if (g.ok && g.data) setGroups((g.data as { groups: GroupInfo[] }).groups || [])
      if (dg.ok && dg.data) setDefaultGroup(dg.data as { groupId: number; name: string; myRole: string })
    }

    useEffect(() => { void refresh() }, [])

    const setDefault = async (groupId: number) => {
      const r = await call('setDefaultGroup', { groupId })
      if (r.ok) {
        setSuccess('默认工作组已更新')
        void refresh()
      } else {
        setError(r.error || '设置失败')
      }
    }

    return (
      <div>
        <h2>用户信息</h2>
        <ErrorBanner error={error} />
        <SuccessBanner msg={success} />
        {user && (
          <section className="card">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                <tr><td style={{ padding: '6px 12px', fontWeight: 600, width: 120 }}>用户 ID</td><td>{user.id}</td></tr>
                <tr><td style={{ padding: '6px 12px', fontWeight: 600 }}>邮箱</td><td>{user.email}</td></tr>
                <tr><td style={{ padding: '6px 12px', fontWeight: 600 }}>用户名</td><td>{user.username}</td></tr>
                <tr><td style={{ padding: '6px 12px', fontWeight: 600 }}>昵称</td><td>{user.nickname}</td></tr>
                <tr><td style={{ padding: '6px 12px', fontWeight: 600 }}>邀请码</td><td><code>{user.invitationCode}</code></td></tr>
              </tbody>
            </table>
          </section>
        )}

        <h2 style={{ marginTop: 20 }}>默认工作组</h2>
        <section className="card">
          {defaultGroup ? (
            <p>当前默认组：<strong>{defaultGroup.name}</strong>（ID: {defaultGroup.groupId}，角色: {defaultGroup.myRole}）</p>
          ) : (
            <p className="muted">未设置默认工作组</p>
          )}
          {groups.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <Field label="切换默认组">
                <select style={inputStyle} value={defaultGroup?.groupId ?? 0} onChange={(e) => setDefault(Number((e.target as HTMLSelectElement).value))}>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name} ({g.myRole})</option>
                  ))}
                </select>
              </Field>
            </div>
          )}
        </section>

        <div style={{ marginTop: 20 }}>
          <button style={btnDanger} onClick={onLogout}>退出登录</button>
        </div>
      </div>
    )
  }

  // ── Group Panel (/groups) ───────────────────────────────────────

  const GroupPanel: ComponentType = () => {
    const [groups, setGroups] = useState<GroupInfo[]>([])
    const [selectedId, setSelectedId] = useState<number | null>(null)
    const [detail, setDetail] = useState<GroupInfo | null>(null)
    const [members, setMembers] = useState<MemberInfo[]>([])
    const [invitations, setInvitations] = useState<InvitationInfo[]>([])
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    // create form
    const [newName, setNewName] = useState('')
    const [newDesc, setNewDesc] = useState('')
    // edit form
    const [editName, setEditName] = useState('')
    const [editDesc, setEditDesc] = useState('')
    // invitation form
    const [invEmail, setInvEmail] = useState('')
    const [invRole, setInvRole] = useState('reader')
    const [invMaxUses, setInvMaxUses] = useState(1)
    const [invTtl, setInvTtl] = useState(604800)
    // accept invitation
    const [acceptCode, setAcceptCode] = useState('')

    const flash = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3000) }
    const fail = (msg: string) => { setError(msg); setTimeout(() => setError(null), 5000) }

    const loadGroups = async () => {
      const r = await call('listGroups')
      if (r.ok && r.data) setGroups((r.data as { groups: GroupInfo[] }).groups || [])
      else fail(r.error || '加载组列表失败')
    }

    const selectGroup = async (id: number) => {
      setSelectedId(id)
      const [d, m, inv] = await Promise.all([
        call('getGroup', { id }),
        call('listMembers', { id }),
        call('listInvitations', { id }),
      ])
      if (d.ok && d.data) {
        const g = (d.data as { group: GroupInfo }).group
        setDetail(g)
        setEditName(g.name)
        setEditDesc(g.description)
      }
      if (m.ok && m.data) setMembers((m.data as { members: MemberInfo[] }).members || [])
      if (inv.ok && inv.data) setInvitations((inv.data as { invitations: InvitationInfo[] }).invitations || [])
    }

    useEffect(() => { void loadGroups() }, [])

    const createGroup = async () => {
      if (!newName.trim()) return fail('组名不能为空')
      const r = await call('createGroup', { name: newName, description: newDesc })
      if (r.ok) { flash('组创建成功'); setNewName(''); setNewDesc(''); void loadGroups() }
      else fail(r.error || '创建失败')
    }

    const updateGroup = async () => {
      if (!selectedId) return
      const r = await call('updateGroup', { id: selectedId, name: editName, description: editDesc })
      if (r.ok) { flash('组已更新'); void selectGroup(selectedId); void loadGroups() }
      else fail(r.error || '更新失败')
    }

    const deleteGroup = async () => {
      if (!selectedId) return
      if (!confirm(`确定要解散组「${detail?.name}」吗？此操作不可撤销。`)) return
      const r = await call('deleteGroup', { id: selectedId })
      if (r.ok) { flash('组已解散'); setSelectedId(null); setDetail(null); void loadGroups() }
      else fail(r.error || '删除失败')
    }

    const leaveGroup = async () => {
      if (!selectedId) return
      if (!confirm(`确定要退出组「${detail?.name}」吗？`)) return
      const r = await call('leaveGroup', { id: selectedId })
      if (r.ok) { flash('已退出组'); setSelectedId(null); setDetail(null); void loadGroups() }
      else fail(r.error || '退出失败')
    }

    const changeRole = async (userId: number, role: string) => {
      if (!selectedId) return
      const r = await call('updateMember', { id: selectedId, userId, role })
      if (r.ok) { flash('角色已更新'); void selectGroup(selectedId) }
      else fail(r.error || '更新角色失败')
    }

    const removeMember = async (userId: number) => {
      if (!selectedId) return
      if (!confirm('确定移除该成员？')) return
      const r = await call('removeMember', { id: selectedId, userId })
      if (r.ok) { flash('成员已移除'); void selectGroup(selectedId) }
      else fail(r.error || '移除失败')
    }

    const createInvitation = async () => {
      if (!selectedId) return
      const r = await call('createInvitation', { id: selectedId, inviteeEmail: invEmail || undefined, role: invRole, maxUses: invMaxUses, ttlSeconds: invTtl })
      if (r.ok) { flash('邀请已创建'); setInvEmail(''); void selectGroup(selectedId) }
      else fail(r.error || '创建邀请失败')
    }

    const revokeInvitation = async (invId: number) => {
      const r = await call('revokeInvitation', { id: invId })
      if (r.ok) { flash('邀请已撤销'); if (selectedId) void selectGroup(selectedId) }
      else fail(r.error || '撤销失败')
    }

    const acceptInvitation = async () => {
      if (!acceptCode.trim()) return fail('邀请码不能为空')
      const r = await call('acceptInvitation', { code: acceptCode })
      if (r.ok) { flash('已加入组'); setAcceptCode(''); void loadGroups() }
      else fail(r.error || '接受邀请失败')
    }

    return (
      <div>
        <ErrorBanner error={error} />
        <SuccessBanner msg={success} />

        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          {/* Group list */}
          <section className="card" style={{ minWidth: 260, flex: '0 0 260px' }}>
            <h3>我的工作组</h3>
            <div style={{ marginBottom: 10 }}>
              {groups.map((g) => (
                <div
                  key={g.id}
                  onClick={() => selectGroup(g.id)}
                  style={{
                    padding: '8px 12px', cursor: 'pointer', borderRadius: 4, marginBottom: 4,
                    background: selectedId === g.id ? '#e8f0fe' : 'transparent',
                    border: selectedId === g.id ? '1px solid #2d72d9' : '1px solid transparent',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{g.name}</div>
                  <div style={{ fontSize: 12, color: '#888' }}>{g.myRole} · {g.memberCount} 成员</div>
                </div>
              ))}
              {groups.length === 0 && <p className="muted">暂无工作组</p>}
            </div>

            <h4 style={{ marginTop: 16 }}>创建新组</h4>
            <Field label="组名">
              <input style={inputStyle} value={newName} onChange={(e) => setNewName((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="描述">
              <input style={inputStyle} value={newDesc} onChange={(e) => setNewDesc((e.target as HTMLInputElement).value)} />
            </Field>
            <button style={btnStyle} onClick={createGroup}>创建组</button>

            <h4 style={{ marginTop: 16 }}>接受邀请</h4>
            <Field label="邀请码">
              <input style={inputStyle} value={acceptCode} onChange={(e) => setAcceptCode((e.target as HTMLInputElement).value)} />
            </Field>
            <button style={btnSecondary} onClick={acceptInvitation}>加入组</button>
          </section>

          {/* Group detail */}
          <section className="card" style={{ flex: 1 }}>
            {!detail ? (
              <p className="muted">选择左侧工作组查看详情</p>
            ) : (
              <>
                <h3>{detail.name}</h3>
                <p className="muted">ID: {detail.id} · 所有者: {detail.ownerId} · 我的角色: {detail.myRole} · 创建: {detail.createdAt}</p>

                <h4>编辑组</h4>
                <Field label="名称">
                  <input style={inputStyle} value={editName} onChange={(e) => setEditName((e.target as HTMLInputElement).value)} />
                </Field>
                <Field label="描述">
                  <input style={inputStyle} value={editDesc} onChange={(e) => setEditDesc((e.target as HTMLInputElement).value)} />
                </Field>
                <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                  <button style={btnStyle} onClick={updateGroup}>保存</button>
                  <button style={btnDanger} onClick={deleteGroup}>解散组</button>
                  {detail.myRole !== 'owner' && <button style={btnSecondary} onClick={leaveGroup}>退出组</button>}
                </div>

                <h4>成员 ({members.length})</h4>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
                      <th style={{ padding: '6px 8px' }}>用户</th>
                      <th style={{ padding: '6px 8px' }}>角色</th>
                      <th style={{ padding: '6px 8px' }}>加入时间</th>
                      <th style={{ padding: '6px 8px' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.userId} style={{ borderBottom: '1px solid #f0f0f0' }}>
                        <td style={{ padding: '6px 8px' }}>{m.nickname || m.email}<br /><span style={{ fontSize: 11, color: '#999' }}>{m.email}</span></td>
                        <td style={{ padding: '6px 8px' }}>
                          <select value={m.role} onChange={(e) => changeRole(m.userId, (e.target as HTMLSelectElement).value)} style={{ fontSize: 12 }}>
                            <option value="owner">owner</option>
                            <option value="admin">admin</option>
                            <option value="writer">writer</option>
                            <option value="reader">reader</option>
                          </select>
                        </td>
                        <td style={{ padding: '6px 8px', fontSize: 12 }}>{m.joinedAt}</td>
                        <td style={{ padding: '6px 8px' }}>
                          {m.role !== 'owner' && (
                            <button style={{ ...btnSmall, color: '#c0392b' }} onClick={() => removeMember(m.userId)}>移除</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h4 style={{ marginTop: 20 }}>创建邀请</h4>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <Field label="邮箱(可选)"><input style={{ ...inputStyle, width: 180 }} value={invEmail} onChange={(e) => setInvEmail((e.target as HTMLInputElement).value)} /></Field>
                  <Field label="角色">
                    <select style={{ ...inputStyle, width: 100 }} value={invRole} onChange={(e) => setInvRole((e.target as HTMLSelectElement).value)}>
                      <option value="admin">admin</option>
                      <option value="writer">writer</option>
                      <option value="reader">reader</option>
                    </select>
                  </Field>
                  <Field label="最大次数"><input style={{ ...inputStyle, width: 80 }} type="number" value={invMaxUses} onChange={(e) => setInvMaxUses(Number((e.target as HTMLInputElement).value))} /></Field>
                  <Field label="有效期(秒)"><input style={{ ...inputStyle, width: 100 }} type="number" value={invTtl} onChange={(e) => setInvTtl(Number((e.target as HTMLInputElement).value))} /></Field>
                  <button style={btnStyle} onClick={createInvitation}>创建邀请</button>
                </div>

                <h4 style={{ marginTop: 20 }}>有效邀请 ({invitations.length})</h4>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
                      <th style={{ padding: '6px 8px' }}>邀请码</th>
                      <th style={{ padding: '6px 8px' }}>角色</th>
                      <th style={{ padding: '6px 8px' }}>使用</th>
                      <th style={{ padding: '6px 8px' }}>过期</th>
                      <th style={{ padding: '6px 8px' }}>状态</th>
                      <th style={{ padding: '6px 8px' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((inv) => (
                      <tr key={inv.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                        <td style={{ padding: '6px 8px' }}><code>{inv.code}</code></td>
                        <td style={{ padding: '6px 8px' }}>{inv.role}</td>
                        <td style={{ padding: '6px 8px' }}>{inv.usedCount}/{inv.maxUses}</td>
                        <td style={{ padding: '6px 8px', fontSize: 12 }}>{inv.expiresAt}</td>
                        <td style={{ padding: '6px 8px' }}>{inv.status}</td>
                        <td style={{ padding: '6px 8px' }}>
                          <button style={{ ...btnSmall, color: '#c0392b' }} onClick={() => revokeInvitation(inv.id)}>撤销</button>
                        </td>
                      </tr>
                    ))}
                    {invitations.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 8 }}>暂无有效邀请</td></tr>}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </div>
      </div>
    )
  }

  // ── KV Panel (/keys) ────────────────────────────────────────────

  const KvPanel: ComponentType = () => {
    const [groups, setGroups] = useState<GroupInfo[]>([])
    const [groupId, setGroupId] = useState<number>(0)
    const [items, setItems] = useState<KvItem[]>([])
    const [total, setTotal] = useState(0)
    const [offset, setOffset] = useState(0)
    const [limit] = useState(50)
    const [search, setSearch] = useState('')
    const [tagFilter, setTagFilter] = useState('')
    const [tags, setTags] = useState<TagInfo[]>([])
    const [selected, setSelected] = useState<KvItem | null>(null)
    const [versions, setVersions] = useState<KvVersion[]>([])
    const [shares, setShares] = useState<ShareInfo[]>([])
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    // editor form
    const [editKey, setEditKey] = useState('')
    const [editValue, setEditValue] = useState('')
    const [editTags, setEditTags] = useState('')
    const [editTtl, setEditTtl] = useState('')
    const [editVisibility, setEditVisibility] = useState('')
    const [editMetadata, setEditMetadata] = useState('')
    const [isNew, setIsNew] = useState(true)

    // share form
    const [shareKey, setShareKey] = useState('')
    const [shareMaxUses, setShareMaxUses] = useState(0)
    const [shareTtl, setShareTtl] = useState(0)

    const pageSize = 50
    const flash = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3000) }
    const fail = (msg: string) => { setError(msg); setTimeout(() => setError(null), 5000) }

    const loadGroups = async () => {
      const r = await call('listGroups')
      if (r.ok && r.data) {
        const gs = (r.data as { groups: GroupInfo[] }).groups || []
        setGroups(gs)
      }
    }

    const loadKv = async () => {
      const query: Record<string, unknown> = { limit, offset }
      if (groupId) query.groupId = groupId
      if (search) query.q = search
      if (tagFilter) query.tags = [tagFilter]
      const r = await call('listKv', query)
      if (r.ok && r.data) {
        const d = r.data as { items: KvItem[]; total: number }
        setItems(d.items || [])
        setTotal(d.total || 0)
      } else fail(r.error || '加载 KV 列表失败')
    }

    const loadTags = async () => {
      const r = await call('listKvTags', { groupId: groupId || 0 })
      if (r.ok && r.data) setTags((r.data as { tags: TagInfo[] }).tags || [])
    }

    const loadShares = async () => {
      const r = await call('listShares', { limit: 100, offset: 0 })
      if (r.ok && r.data) setShares((r.data as { items: ShareInfo[] }).items || [])
    }

    useEffect(() => { void loadGroups() }, [])
    useEffect(() => { void loadKv(); void loadTags() }, [groupId, offset, search, tagFilter])

    const openEditor = (item: KvItem | null) => {
      if (item) {
        setIsNew(false)
        setEditKey(item.key)
        setEditValue(item.value)
        setEditTags((item.tags || []).join(', '))
        setEditTtl('')
        setEditVisibility(item.visibility || '')
        setEditMetadata(item.metadata ? JSON.stringify(item.metadata, null, 2) : '')
      } else {
        setIsNew(true)
        setEditKey('')
        setEditValue('')
        setEditTags('')
        setEditTtl('')
        setEditVisibility('')
        setEditMetadata('')
      }
    }

    const saveKv = async () => {
      if (!editKey.trim()) return fail('Key 不能为空')
      const body: Record<string, unknown> = { key: editKey, value: editValue }
      if (editTags.trim()) body.tags = editTags.split(',').map((t) => t.trim()).filter(Boolean)
      if (editTtl.trim()) body.ttl = Number(editTtl)
      if (editVisibility) body.visibility = editVisibility
      if (editMetadata.trim()) {
        try { body.metadata = JSON.parse(editMetadata) } catch { return fail('metadata 不是有效 JSON') }
      }
      if (groupId) body.groupId = groupId
      const r = await call('setKv', body)
      if (r.ok) { flash(isNew ? 'KV 已创建' : 'KV 已更新'); void loadKv(); void loadTags() }
      else fail(r.error || '保存失败')
    }

    const deleteKv = async (key: string) => {
      if (!confirm(`确定删除 key「${key}」？`)) return
      const r = await call('deleteKv', { key, groupId: groupId || 0 })
      if (r.ok) { flash('KV 已删除'); if (selected?.key === key) setSelected(null); void loadKv(); void loadTags() }
      else fail(r.error || '删除失败')
    }

    const selectKv = async (item: KvItem) => {
      setSelected(item)
      openEditor(item)
      const [v] = await Promise.all([call('listKvVersions', { key: item.key, groupId: groupId || 0 })])
      if (v.ok && v.data) setVersions((v.data as { versions: KvVersion[] }).versions || [])
    }

    const restoreVersion = async (key: string, version: number) => {
      if (!confirm(`恢复到版本 ${version}？`)) return
      const r = await call('restoreKv', { key, version, groupId: groupId || 0 })
      if (r.ok) { flash('已恢复到版本 ' + version); void loadKv() }
      else fail(r.error || '恢复失败')
    }

    const setVisibility = async (key: string, vis: string) => {
      const r = await call('setKvVisibility', { key, groupId: groupId || 0, visibility: vis })
      if (r.ok) { flash('可见性已更新'); void loadKv() }
      else fail(r.error || '设置失败')
    }

    const duplicateKv = async (key: string) => {
      const target = prompt('输入目标组 ID：')
      if (!target) return
      const r = await call('duplicateKv', { key, sourceGroupId: groupId || 0, targetGroupId: Number(target) })
      if (r.ok) flash('KV 已复制到目标组')
      else fail(r.error || '复制失败')
    }

    const createShare = async () => {
      if (!shareKey.trim()) return fail('请输入 key')
      const body: Record<string, unknown> = { key: shareKey }
      if (groupId) body.groupId = groupId
      if (shareMaxUses > 0) body.maxUses = shareMaxUses
      if (shareTtl > 0) body.ttl = shareTtl
      const r = await call('createShare', body)
      if (r.ok) {
        const d = r.data as { code: string; accessUrl: string }
        flash(`分享已创建: ${d.code}`)
        void loadShares()
      } else fail(r.error || '创建分享失败')
    }

    const deleteShare = async (code: string) => {
      const r = await call('deleteShare', { code })
      if (r.ok) { flash('分享已删除'); void loadShares() }
      else fail(r.error || '删除失败')
    }

    const totalPages = Math.ceil(total / pageSize)
    const currentPage = Math.floor(offset / pageSize) + 1

    return (
      <div>
        <ErrorBanner error={error} />
        <SuccessBanner msg={success} />

        {/* Toolbar */}
        <section className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="工作组">
              <select style={{ ...inputStyle, width: 200 }} value={groupId} onChange={(e) => { setGroupId(Number((e.target as HTMLSelectElement).value)); setOffset(0) }}>
                <option value={0}>默认组</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
            <Field label="搜索">
              <input style={{ ...inputStyle, width: 200 }} value={search} onChange={(e) => { setSearch((e.target as HTMLInputElement).value); setOffset(0) }} placeholder="搜索 key/value" />
            </Field>
            <Field label="标签过滤">
              <input style={{ ...inputStyle, width: 140 }} value={tagFilter} onChange={(e) => { setTagFilter((e.target as HTMLInputElement).value); setOffset(0) }} placeholder="tag" />
            </Field>
            <button style={btnSecondary} onClick={() => { openEditor(null); setSelected(null) }}>新建 KV</button>
            <button style={btnSecondary} onClick={() => void loadShares()}>管理分享</button>
          </div>
          {tags.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {tags.map((t) => (
                <span
                  key={t.tag}
                  onClick={() => { setTagFilter(t.tag); setOffset(0) }}
                  style={{ padding: '2px 8px', background: tagFilter === t.tag ? '#2d72d9' : '#eee', color: tagFilter === t.tag ? '#fff' : '#333', borderRadius: 10, fontSize: 12, cursor: 'pointer' }}
                >
                  {t.tag} ({t.count})
                </span>
              ))}
              {tagFilter && <span onClick={() => setTagFilter('')} style={{ padding: '2px 8px', cursor: 'pointer', color: '#999', fontSize: 12 }}>清除</span>}
            </div>
          )}
        </section>

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          {/* KV list */}
          <section className="card" style={{ flex: 1, minWidth: 0 }}>
            <h3>KV 列表 ({total})</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Key</th>
                  <th style={{ padding: '6px 8px' }}>Value (预览)</th>
                  <th style={{ padding: '6px 8px' }}>标签</th>
                  <th style={{ padding: '6px 8px' }}>可见性</th>
                  <th style={{ padding: '6px 8px' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.key} style={{ borderBottom: '1px solid #f0f0f0', background: selected?.key === item.key ? '#f5f8ff' : 'transparent' }}>
                    <td style={{ padding: '6px 8px', cursor: 'pointer', fontWeight: 600 }} onClick={() => selectKv(item)}><code>{item.key}</code></td>
                    <td style={{ padding: '6px 8px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.value?.slice(0, 60)}</td>
                    <td style={{ padding: '6px 8px' }}>{(item.tags || []).join(', ')}</td>
                    <td style={{ padding: '6px 8px' }}>{item.visibility || '-'}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <button style={btnSmall} onClick={() => selectKv(item)}>编辑</button>{' '}
                      <button style={{ ...btnSmall, color: '#c0392b' }} onClick={() => deleteKv(item.key)}>删除</button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 12 }}>暂无 KV 数据</td></tr>}
              </tbody>
            </table>
            {totalPages > 1 && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                <button style={btnSmall} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>上一页</button>
                <span style={{ fontSize: 13 }}>第 {currentPage} / {totalPages} 页</span>
                <button style={btnSmall} disabled={offset + pageSize >= total} onClick={() => setOffset(offset + pageSize)}>下一页</button>
              </div>
            )}
          </section>

          {/* Editor / detail */}
          <section className="card" style={{ flex: '0 0 420px' }}>
            <h3>{isNew ? '新建 KV' : '编辑 KV'}</h3>
            <Field label="Key">
              <input style={inputStyle} value={editKey} onChange={(e) => setEditKey((e.target as HTMLInputElement).value)} disabled={!isNew} />
            </Field>
            <Field label="Value">
              <textarea style={{ ...inputStyle, fontFamily: 'monospace', minHeight: 120 }} value={editValue} onChange={(e) => setEditValue((e.target as HTMLTextAreaElement).value)} />
            </Field>
            <Field label="Tags (逗号分隔)">
              <input style={inputStyle} value={editTags} onChange={(e) => setEditTags((e.target as HTMLInputElement).value)} />
            </Field>
            <div style={{ display: 'flex', gap: 10 }}>
              <Field label="TTL (秒, 空=永不过期)">
                <input style={{ ...inputStyle, width: 140 }} value={editTtl} onChange={(e) => setEditTtl((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="可见性">
                <select style={{ ...inputStyle, width: 120 }} value={editVisibility} onChange={(e) => setEditVisibility((e.target as HTMLSelectElement).value)}>
                  <option value="">不修改</option>
                  <option value="private">private</option>
                  <option value="public">public</option>
                </select>
              </Field>
            </div>
            <Field label="Metadata (JSON)">
              <textarea style={{ ...inputStyle, fontFamily: 'monospace', minHeight: 60, fontSize: 12 }} value={editMetadata} onChange={(e) => setEditMetadata((e.target as HTMLTextAreaElement).value)} />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={btnStyle} onClick={saveKv}>{isNew ? '创建' : '保存'}</button>
              {!isNew && selected && (
                <>
                  <button style={btnSecondary} onClick={() => duplicateKv(selected.key)}>复制到组</button>
                  <button style={btnDanger} onClick={() => deleteKv(selected.key)}>删除</button>
                </>
              )}
            </div>

            {/* Versions */}
            {!isNew && versions.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <h4>版本历史</h4>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ borderBottom: '1px solid #eee', textAlign: 'left' }}><th style={{ padding: '4px' }}>版本</th><th style={{ padding: '4px' }}>长度</th><th style={{ padding: '4px' }}>时间</th><th></th></tr></thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.version_no} style={{ borderBottom: '1px solid #f5f5f5' }}>
                        <td style={{ padding: '4px' }}>v{v.version_no}</td>
                        <td style={{ padding: '4px' }}>{v.value_len}</td>
                        <td style={{ padding: '4px' }}>{v.replaced_at}</td>
                        <td style={{ padding: '4px' }}><button style={btnSmall} onClick={() => restoreVersion(selected!.key, v.version_no)}>恢复</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Visibility quick toggle */}
            {!isNew && selected && (
              <div style={{ marginTop: 16 }}>
                <h4>可见性</h4>
                <button style={btnSmall} onClick={() => setVisibility(selected.key, 'public')}>设为公开</button>{' '}
                <button style={btnSmall} onClick={() => setVisibility(selected.key, 'private')}>设为私有</button>
              </div>
            )}
          </section>
        </div>

        {/* Shares modal-ish section */}
        {shares.length > 0 && (
          <section className="card" style={{ marginTop: 16 }}>
            <h3>我的分享 ({shares.length})</h3>
            <div style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <Field label="Key"><input style={{ ...inputStyle, width: 160 }} value={shareKey} onChange={(e) => setShareKey((e.target as HTMLInputElement).value)} /></Field>
              <Field label="最大次数(0=无限)"><input style={{ ...inputStyle, width: 100 }} type="number" value={shareMaxUses} onChange={(e) => setShareMaxUses(Number((e.target as HTMLInputElement).value))} /></Field>
              <Field label="TTL秒(0=永不过期)"><input style={{ ...inputStyle, width: 100 }} type="number" value={shareTtl} onChange={(e) => setShareTtl(Number((e.target as HTMLInputElement).value))} /></Field>
              <button style={btnStyle} onClick={createShare}>创建分享</button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ borderBottom: '2px solid #eee', textAlign: 'left' }}><th style={{ padding: '6px' }}>Code</th><th style={{ padding: '6px' }}>KV ID</th><th style={{ padding: '6px' }}>使用</th><th style={{ padding: '6px' }}>过期</th><th style={{ padding: '6px' }}>状态</th><th style={{ padding: '6px' }}>链接</th><th style={{ padding: '6px' }}>操作</th></tr></thead>
              <tbody>
                {shares.map((s) => (
                  <tr key={s.code} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '6px' }}><code>{s.code}</code></td>
                    <td style={{ padding: '6px' }}>{s.kvId}</td>
                    <td style={{ padding: '6px' }}>{s.usedCount}/{s.maxUses}</td>
                    <td style={{ padding: '6px', fontSize: 12 }}>{s.expiresAt}</td>
                    <td style={{ padding: '6px' }}>{s.status}</td>
                    <td style={{ padding: '6px', fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}><a href={s.accessUrl} target="_blank" rel="noreferrer">{s.accessUrl}</a></td>
                    <td style={{ padding: '6px' }}><button style={{ ...btnSmall, color: '#c0392b' }} onClick={() => deleteShare(s.code)}>删除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    )
  }

  // ── View wrappers: TopBar + view, one per registered sub-route ──
  // Registered route Components must be self-sufficient (they render
  // standalone under the shell's boundary), so each carries the
  // fullscreen top bar with the plugin-owned local nav + 返回壳.

  const DashboardView: ComponentType = () => {
    const navigate = useNavigate()
    return (
      <>
        <TopBar />
        <Dashboard onLoginNeeded={() => navigate('/devctr-kv/user')} />
      </>
    )
  }

  const GroupsView: ComponentType = () => (
    <>
      <TopBar />
      <div className="page">
        <h1>工作组</h1>
      </div>
      <div style={{ padding: '0 28px 28px' }}>
        <GroupPanel />
      </div>
    </>
  )

  const KeysView: ComponentType = () => (
    <>
      <TopBar />
      <div className="page">
        <h1>键管理</h1>
      </div>
      <div style={{ padding: '0 28px 28px' }}>
        <KvPanel />
      </div>
    </>
  )

  const UserView: ComponentType = () => (
    <>
      <TopBar />
      <div className="page">
        <UserPanel />
      </div>
    </>
  )

  ctx.pages.register({
    pluginId: id,
    path: '/devctr-kv',
    title: 'DevCtr KV',
    order: 220,
    layout: 'fullscreen',
    routes: [
      { path: '/', Component: DashboardView },
      { path: '/groups', Component: GroupsView },
      { path: '/keys', Component: KeysView },
      { path: '/user', Component: UserView },
    ],
    Component: DashboardView,
  })
}

;(browserHalf as typeof browserHalf & { inject?: string[] }).inject = ['pages', 'auditClient', 'hostCall']

export default browserHalf
