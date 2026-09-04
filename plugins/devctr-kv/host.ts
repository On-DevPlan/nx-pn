/**
 * devctr-kv — host half.
 *
 * Manages the JWT token in memory and wraps every login / group / kv
 * endpoint as a cordis event that the browser half fires via WS RPC.
 * Every outbound request goes through ctx.auditClient so it is audited
 * and attributed to `devctr-kv`.
 *
 * Event namespace: `devctr-kv/<action>`
 * Every handler returns { ok: boolean, data?: unknown, error?: string, status?: number }
 */

// ── Types ──────────────────────────────────────────────────────────

interface AuditResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  bytes: number
  truncated: boolean
  bodyText: string
  bodyJson?: unknown
}

interface HostCtx {
  logger: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  on(event: string, handler: (payload?: unknown) => unknown): unknown
  auditClient: {
    get(url: string, config?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<AuditResponse>
    post(url: string, body?: unknown, config?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<AuditResponse>
    put(url: string, body?: unknown, config?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<AuditResponse>
    patch(url: string, body?: unknown, config?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<AuditResponse>
    delete(url: string, config?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<AuditResponse>
  }
}

type PluginFn = ((ctx: HostCtx, config?: { name?: string }) => void) & {
  inject?: string[]
}

interface ApiResult {
  ok: boolean
  data?: unknown
  error?: string
  status?: number
}

// ── Constants ──────────────────────────────────────────────────────

const BASE_URL = 'http://47.110.80.47:8988'
const NS = 'devctr-kv'

// ── Plugin ─────────────────────────────────────────────────────────

const plugin = function plugin(ctx: HostCtx, config?: { name?: string }): void {
  const id = config?.name ?? NS
  ctx.logger.info(`[${id}] host half active`)

  // Token lives in this closure; browser half never sees it directly.
  let token: string | null = null

  // ── Helpers ─────────────────────────────────────────────────────

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (token) h.authorization = `Bearer ${token}`
    return h
  }

  function buildUrl(path: string, query?: Record<string, unknown>): string {
    let url = BASE_URL + path
    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue
        if (Array.isArray(v)) {
          for (const item of v) params.append(k, String(item))
        } else {
          params.set(k, String(v))
        }
      }
      const qs = params.toString()
      if (qs) url += '?' + qs
    }
    return url
  }

  async function parseResponse(res: AuditResponse): Promise<ApiResult> {
    let data: unknown = undefined
    let errorMsg: string | undefined
    if (res.bodyText) {
      try {
        const parsed = JSON.parse(res.bodyText)
        // Backend wraps as { code, message, data } — unwrap when possible
        if (parsed && typeof parsed === 'object' && 'code' in parsed) {
          if (parsed.code === 0 || parsed.code === 200) {
            data = parsed.data !== undefined ? parsed.data : parsed
          } else {
            errorMsg = parsed.message || `API error code ${parsed.code}`
          }
        } else {
          data = parsed
        }
      } catch {
        data = res.bodyText
      }
    }
    const ok = res.status >= 200 && res.status < 300 && !errorMsg
    const result: ApiResult = { ok, status: res.status }
    if (data !== undefined) result.data = data
    if (errorMsg) result.error = errorMsg
    return result
  }

  async function apiGet(path: string, query?: Record<string, unknown>): Promise<ApiResult> {
    try {
      const res = await ctx.auditClient.get(buildUrl(path, query), { headers: authHeaders() })
      return parseResponse(res)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  async function apiPost(path: string, body?: unknown, query?: Record<string, unknown>): Promise<ApiResult> {
    try {
      const res = await ctx.auditClient.post(buildUrl(path, query), body ? JSON.stringify(body) : undefined, { headers: authHeaders() })
      return parseResponse(res)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  async function apiPatch(path: string, body?: unknown, query?: Record<string, unknown>): Promise<ApiResult> {
    try {
      const res = await ctx.auditClient.patch(buildUrl(path, query), body ? JSON.stringify(body) : undefined, { headers: authHeaders() })
      return parseResponse(res)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  async function apiDelete(path: string, query?: Record<string, unknown>): Promise<ApiResult> {
    try {
      const res = await ctx.auditClient.delete(buildUrl(path, query), { headers: authHeaders() })
      return parseResponse(res)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  function reg(action: string, handler: (payload: Record<string, unknown>) => Promise<ApiResult>): void {
    ctx.on(`${NS}/${action}`, (payload?: unknown) => {
      const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
      return handler(p).catch((err: unknown) => ({ ok: false, error: (err as Error).message }))
    })
  }

  // ── Auth ────────────────────────────────────────────────────────

  /** POST /api/v1/user/login  { email, password } */
  reg('login', async (p) => {
    const r = await apiPost('/api/v1/user/login', { email: p.email, password: p.password })
    if (r.ok && r.data && typeof r.data === 'object') {
      const d = r.data as { token?: string }
      if (d.token) {
        token = d.token
        ctx.logger.info(`[${id}] login success, token stored`)
      }
    }
    return r
  })

  /** Clear local token (no server call) */
  reg('logout', async () => {
    token = null
    ctx.logger.info(`[${id}] logged out (token cleared)`)
    return { ok: true, data: { message: 'logged out' } }
  })

  /** GET /api/v1/user/info */
  reg('userInfo', async () => apiGet('/api/v1/user/info'))

  /** GET /api/v1/user/default-group */
  reg('getDefaultGroup', async () => apiGet('/api/v1/user/default-group'))

  /** PATCH /api/v1/user/default-group  { groupId } */
  reg('setDefaultGroup', async (p) => apiPatch('/api/v1/user/default-group', { groupId: p.groupId }))

  // ── Groups ──────────────────────────────────────────────────────

  /** GET /api/v1/groups */
  reg('listGroups', async () => apiGet('/api/v1/groups'))

  /** POST /api/v1/groups  { name, description? } */
  reg('createGroup', async (p) => apiPost('/api/v1/groups', { name: p.name, description: p.description ?? '' }))

  /** GET /api/v1/groups/{id} */
  reg('getGroup', async (p) => apiGet(`/api/v1/groups/${p.id}`))

  /** PATCH /api/v1/groups/{id}  { name?, description? } */
  reg('updateGroup', async (p) => {
    const body: Record<string, unknown> = {}
    if (p.name !== undefined) body.name = p.name
    if (p.description !== undefined) body.description = p.description
    return apiPatch(`/api/v1/groups/${p.id}`, body)
  })

  /** DELETE /api/v1/groups/{id} */
  reg('deleteGroup', async (p) => apiDelete(`/api/v1/groups/${p.id}`))

  /** POST /api/v1/groups/{id}/leave */
  reg('leaveGroup', async (p) => apiPost(`/api/v1/groups/${p.id}/leave`))

  // ── Members ─────────────────────────────────────────────────────

  /** GET /api/v1/groups/{id}/members */
  reg('listMembers', async (p) => apiGet(`/api/v1/groups/${p.id}/members`))

  /** PATCH /api/v1/groups/{id}/members/{userId}  { role } */
  reg('updateMember', async (p) => apiPatch(`/api/v1/groups/${p.id}/members/${p.userId}`, { role: p.role }))

  /** DELETE /api/v1/groups/{id}/members/{userId} */
  reg('removeMember', async (p) => apiDelete(`/api/v1/groups/${p.id}/members/${p.userId}`))

  // ── Invitations ─────────────────────────────────────────────────

  /** GET /api/v1/groups/{id}/invitations */
  reg('listInvitations', async (p) => apiGet(`/api/v1/groups/${p.id}/invitations`))

  /** POST /api/v1/groups/{id}/invitations  { inviteeEmail?, role?, maxUses?, ttlSeconds? } */
  reg('createInvitation', async (p) => {
    const body: Record<string, unknown> = {}
    if (p.inviteeEmail) body.inviteeEmail = p.inviteeEmail
    if (p.role) body.role = p.role
    if (p.maxUses !== undefined) body.maxUses = p.maxUses
    if (p.ttlSeconds !== undefined) body.ttlSeconds = p.ttlSeconds
    return apiPost(`/api/v1/groups/${p.id}/invitations`, body)
  })

  /** POST /api/v1/group-invitations/{id}/revoke */
  reg('revokeInvitation', async (p) => apiPost(`/api/v1/group-invitations/${p.id}/revoke`))

  /** POST /api/v1/group-invitations/accept  { code } */
  reg('acceptInvitation', async (p) => apiPost('/api/v1/group-invitations/accept', { code: p.code }))

  // ── KV ──────────────────────────────────────────────────────────

  /** GET /api/v1/kv  query: limit?, offset?, tags?, q?, groupId? */
  reg('listKv', async (p) => {
    const query: Record<string, unknown> = {}
    if (p.limit !== undefined) query.limit = p.limit
    if (p.offset !== undefined) query.offset = p.offset
    if (p.tags !== undefined) query.tags = p.tags
    if (p.q !== undefined) query.q = p.q
    if (p.groupId !== undefined) query.groupId = p.groupId
    return apiGet('/api/v1/kv', query)
  })

  /** POST /api/v1/kv  { key, value, ttl?, tags?, groupId?, metadata?, visibility? } */
  reg('setKv', async (p) => {
    const body: Record<string, unknown> = { key: p.key, value: p.value }
    if (p.ttl !== undefined) body.ttl = p.ttl
    if (p.tags !== undefined) body.tags = p.tags
    if (p.groupId !== undefined) body.groupId = p.groupId
    if (p.metadata !== undefined) body.metadata = p.metadata
    if (p.visibility !== undefined) body.visibility = p.visibility
    return apiPost('/api/v1/kv', body)
  })

  /** GET /api/v1/kv/:key  query: key, groupId? */
  reg('getKv', async (p) => apiGet('/api/v1/kv/:key', { key: p.key, groupId: p.groupId ?? 0 }))

  /** DELETE /api/v1/kv/:key  query: key, groupId? */
  reg('deleteKv', async (p) => apiDelete('/api/v1/kv/:key', { key: p.key, groupId: p.groupId ?? 0 }))

  /** POST /api/v1/kv/:key/duplicate  { key, sourceGroupId?, targetGroupId } */
  reg('duplicateKv', async (p) => {
    const body: Record<string, unknown> = { key: p.key, targetGroupId: p.targetGroupId }
    if (p.sourceGroupId !== undefined) body.sourceGroupId = p.sourceGroupId
    return apiPost('/api/v1/kv/:key/duplicate', body)
  })

  /** POST /api/v1/kv/:key/restore  { key, version, groupId? } */
  reg('restoreKv', async (p) => {
    const body: Record<string, unknown> = { key: p.key, version: p.version }
    if (p.groupId !== undefined) body.groupId = p.groupId
    return apiPost('/api/v1/kv/:key/restore', body)
  })

  /** GET /api/v1/kv/:key/versions  query: key, groupId? */
  reg('listKvVersions', async (p) => apiGet('/api/v1/kv/:key/versions', { key: p.key, groupId: p.groupId ?? 0 }))

  /** POST /api/v1/kv/:key/visibility  { key, groupId?, visibility } */
  reg('setKvVisibility', async (p) => {
    const body: Record<string, unknown> = { key: p.key, visibility: p.visibility }
    if (p.groupId !== undefined) body.groupId = p.groupId
    return apiPost('/api/v1/kv/:key/visibility', body)
  })

  /** GET /api/v1/kv/public/:key  query: key, groupId (required) */
  reg('getPublicKv', async (p) => apiGet('/api/v1/kv/public/:key', { key: p.key, groupId: p.groupId }))

  // ── KV Shares ───────────────────────────────────────────────────

  /** POST /api/v1/kv/share  { key, maxUses?, ttl?, groupId? } */
  reg('createShare', async (p) => {
    const body: Record<string, unknown> = { key: p.key }
    if (p.maxUses !== undefined) body.maxUses = p.maxUses
    if (p.ttl !== undefined) body.ttl = p.ttl
    if (p.groupId !== undefined) body.groupId = p.groupId
    return apiPost('/api/v1/kv/share', body)
  })

  /** GET /api/v1/kv/share/:code  query: code */
  reg('accessShare', async (p) => apiGet('/api/v1/kv/share/:code', { code: p.code }))

  /** DELETE /api/v1/kv/share/:code  query: code */
  reg('deleteShare', async (p) => apiDelete('/api/v1/kv/share/:code', { code: p.code }))

  /** GET /api/v1/kv/shares  query: limit?, offset? */
  reg('listShares', async (p) => {
    const query: Record<string, unknown> = {}
    if (p.limit !== undefined) query.limit = p.limit
    if (p.offset !== undefined) query.offset = p.offset
    return apiGet('/api/v1/kv/shares', query)
  })

  /** GET /api/v1/kv/tags  query: groupId? */
  reg('listKvTags', async (p) => apiGet('/api/v1/kv/tags', { groupId: p.groupId ?? 0 }))

  ctx.logger.info(`[${id}] registered ${NS}/* event handlers`)
}

;(plugin as PluginFn).inject = ['auditClient']

export default plugin
