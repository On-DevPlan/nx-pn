# API Audit — 设计规范

> 版本：v3（最终版，由设计 v2 + 对抗式 6 视角评审后 6 项已确认变更折叠而成）
> 日期：2026-09-03
> 路径：`docs/superpowers/specs/2026-09-03-api-audit-design.md`

---

## 1. 概述与目标

**api-audit** 是一个 API 审计 Web 应用，按 deepseek-harness 模式构建为 **cordis 插件平台**：Node 侧 host 进程托管 Web 界面、运行 cordis Context、暴露统一 `AuditClient`，所有上传插件的网络 IO 强制经此 Client 完成并落入审计链路。

**核心页面由 core 提供，专注于 client 审计**：审计记录（`/audit`）与 API 重放（`/replay`）。其余页面（含基础设施插件管理页 `/plugins`）由插件生态提供。

### 1.1 关键术语

| 术语 | 含义 |
|---|---|
| **core** | `packages/core`：纯契约层（接口、中间件类型、manifest schema），零 cordis Context 增强 |
| **host** | `packages/host`：Node 侧运行时，包含 cordis Context、HTTP/WS 服务、Client 实现、审计中间件、插件运行器 |
| **client** | `packages/client`：浏览器侧运行时，包含 cordis 浏览器 Context、WS RPC 桥、Client 代理、Pages 服务 |
| **AuditClient** | core 暴露的 HTTP 客户端抽象接口，host 实现真正的 fetch + 中间件链，client 暴露同名代理（经 WS RPC 转发） |
| **双半动态包** | 一个 zip 插件包含 host 半（Node 侧 ESM）和/或 browser 半（浏览器侧 ESM），由 host 编译后下发 |
| **pluginRunId** | host 为每次成功的插件装载派发的单调 id，浏览器侧 WS RPC invoke 必须按 pluginRunId 对账（陈旧拒绝） |
| **凭证引用** | 审计中间件将 `authorization`/`cookie`/`x-api-key` 等敏感头在记录中替换为 `{present, hash}`；重放时若宿主当前凭证服务能匹配 hash 则注入新值 |

---

## 2. 架构

### 2.1 Monorepo 布局（Nx + pnpm）

```
nx-pn/
├── apps/
│   ├── cli/                 # npx 入口 bin: api-audit；启动 host；开浏览器
│   └── web/                 # React 18 + Vite 壳，预构建 dist 由 host 静态托管
├── packages/
│   ├── core/                # 纯契约层（零 Context 增强）
│   ├── host/                # Node 侧运行时
│   └── client/              # 浏览器侧运行时
├── plugins/
│   └── example-api/         # 示例 zip 双半插件
├── docs/superpowers/specs/  # 本规范所在
└── tools/                   # （预留）脚本与构建工具
```

**pnpm-workspace.yaml**：`apps/*`、`packages/*`、`plugins/*`。
**nx.json**：使用 Nx 的 `run-many` 与 `dependsOn` 维护构建顺序。

### 2.2 启动流程

1. 用户执行 `npx api-audit`（或开发期 `pnpm dev`）→ `apps/cli` 的 bin 启动
2. CLI 创建 host 进程上下文：初始化 `data-dir/`（默认 `~/.api-audit/`）、加载 `packages/host`
3. Host 启动 HTTP 服务器（默认端口 `4560`，可用 `--port` 覆盖）
4. Host 通过 `createRequire` + `require.resolve('@api-audit/web/package.json')` 定位 `apps/web/dist` 根
5. Host 启动 WebSocket 服务（同端口不同 path）
6. Host 初始化 cordis Context，注册 `client` 服务、审计中间件、内置 pages
7. Host 扫描 `data-dir/plugins/*.zip`，按 `{zip_path, plugin_id}` 维度逐个装载：
   - esbuild 编译 host 半 → `data-dir/cache/compiled/<plugin_id>-<hash>.mjs`
   - `pathToFileURL(...)` 转 `file://` 后 `import()`
   - `ctx.plugin(halfFn)` → `await fiber.await()` → 注册 `{id, pluginRunId, fiber}`
8. 浏览器访问 `http://localhost:4560` → 加载 `apps/web/dist`
9. `apps/web/src/main.ts` 创建 cordis **浏览器** Context，加载内置（`pages`、`client` 代理），发起 WS 连接
10. 浏览器通过 WS RPC 拉取插件清单 → 装载 browser 半 → 出现侧边导航

### 2.3 构建链（变更 E）

#### 2.3.1 静态托管锚定

- `apps/web/package.json`：
  - `"exports": { "./dist/*": "./dist/*", "./package.json": "./package.json" }`
  - `"files": ["dist", "!dist/**/*.map"]`
- `packages/host/package.json`：`"dependencies": { "@api-audit/web": "workspace:^" }`
- Host 端 `frontend-static` 服务：
  - 用 `createRequire(import.meta.url)` 创建 require 函数
  - `require.resolve('@api-audit/web/package.json')` 锚定 dist 根
  - **每请求实时 `readFile`**（无缓存），启动时容忍 dist 缺失（返回 503 + 提示先构建）
  - 静态路径：`GET /` → `dist/index.html`，`GET /assets/*` → `dist/assets/*`

#### 2.3.2 构建顺序

- **Nx `targetDefaults`**：`build` 任务 `dependsOn: ['^build']`，强制依赖先构建
- **手动串联**：`core` → `host`/`client`（独立）→ `web` → `cli`
- **@nx/vite 配置**：`apps/web` 显式设置 `build.outDir = "apps/web/dist"`，并把 `dist/` 声明进 `outputs` 数组

#### 2.3.3 dev watch 三段链

```
类型产物（tsc -b）→ 各包 lib 构建（tsdown/tsc emit）→ vite build --watch --no-emptyOutDir（cwd=apps/web）
```

- 三段必须按序执行；缺段会**静默展示旧产物**（已构建过的 dist 不会被清除）
- 开发启动前需先完成一次全量构建（可用 `nx run-many -t build` 前置）
- `vite` 必须以 `apps/web` 为 cwd 启动；否则 React 副本可能被静默切换（hook/context 身份断裂）

### 2.4 TypeScript 工程结构（变更 F — 路线 1）

**推荐采用单程序路线**，禁止中途切换为 dsh 双聚合。

- `packages/core`：**零** cordis Context 增强，**只导出共享契约类型**（含两侧共用的 `AuditClient` 接口与 `Manifest` schema）
- `packages/host` 与 `packages/client`：Context 增强键互斥；如需同键（如 `auditClient`），必须从 `packages/core` 导入同一类型
- **根 `tsconfig.json`**：作为 program-less solution（`files: []`），仅通过 `references` 引用各包的 `tsconfig.json`
- **每包 `tsconfig.json`**：`composite: true`，并声明 `tsBuildInfoFile: "lib/tsconfig.tsbuildinfo"`
- **Nx 任务**：使用 `run-commands` 执行 `tsc -b`；把 `lib/`、`lib/**/*.d.ts`、`lib/tsconfig.tsbuildinfo` 声明进 `outputs`

若未来出现不可避免的同键异型需求（例如 host 与 client 各自定义同名但实现不同的 service），需重新评审后才能切换到 dsh 双聚合方案。

---

## 3. packages/core

`packages/core` 是**纯契约层**，不引入 cordis Context 增强，不实现任何运行时逻辑（除 manifest schema 的运行时校验）。

### 3.1 AuditClient 接口

```ts
// packages/core/src/audit-client.ts
export interface AuditClient {
  get(url: string, config?: RequestConfig): Promise<AuditResponse>
  post(url: string, body?: BodyInit | unknown, config?: RequestConfig): Promise<AuditResponse>
  put(url: string, body?: BodyInit | unknown, config?: RequestConfig): Promise<AuditResponse>
  patch(url: string, body?: BodyInit | unknown, config?: RequestConfig): Promise<AuditResponse>
  delete(url: string, config?: RequestConfig): Promise<AuditResponse>
}

export interface RequestConfig {
  headers?: Record<string, string>
  signal?: AbortSignal
  /** 默认 30_000；与 WS RPC 默认超时同值 */
  timeoutMs?: number
}

export interface AuditResponse {
  status: number
  statusText: string
  /** 已解压的 header（undici 透明解压后），非 wire 头 */
  headers: Record<string, string>
  /** body 字节数（解压后） */
  bytes: number
  /** 是否被截断（超过 MAX_BODY_BYTES） */
  truncated: boolean
  /** 预览或完整 body；JSON 自动 `JSON.parse` 后 `JSON.stringify`；否则 utf-8 string；truncated 时为前 4 KB */
  bodyText: string
  /** 若 body 能 parse 为 JSON 且未 truncated，提供结构化视图 */
  bodyJson?: unknown
}

export const MAX_BODY_BYTES = 1_048_576 // 1 MiB
```

**范围声明**（基于评审反方的有用建议）：`AuditClient` 适用于**有界请求/响应**语义；流式响应（chat completion SSE、webhook 长开）需走专门 Provider 通道（本期不在范围内）。

### 3.2 Middleware 洋葱模型

```ts
export type Next = () => Promise<AuditResponse>

export interface Middleware {
  (ctx: MiddlewareContext, next: Next): Promise<AuditResponse>
}

export interface MiddlewareContext {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  /** 自动注入的发起方标识（pluginId 或 'replay:<recordId>' 或 'core'） */
  initiator: string
  headers: Record<string, string>
  /** 序列化后 body（已做凭证脱敏） */
  body?: string
  /** 与该请求关联的 pluginRunId（浏览器半发起时） */
  pluginRunId?: string
}
```

中间件按洋葱模型串联：`mw1 → mw2 → mw3 → (fetch) → mw3' → mw2' → mw1'`。`audit` 中间件处于最外层，负责构造与持久化审计记录。

### 3.3 Manifest Schema

```ts
// packages/core/src/manifest.ts
export const MANIFEST_VERSION = 1

export interface Manifest {
  /** schema 版本 */
  schemaVersion: typeof MANIFEST_VERSION
  /** 全局唯一 id（小写字母数字加 `-`） */
  id: string
  /** 语义化版本 */
  version: string
  /** 人类可读标题 */
  title: string
  /** 半声明：至少其一 */
  halves: {
    host?: HalfEntry
    browser?: HalfEntry
  }
  /** 注入依赖；具体服务列表由运行时校验（host/client 各自核对） */
  inject?: string[]
}

export interface HalfEntry {
  /** 相对 zip 根的文件名，如 "host.js" / "browser.jsx" */
  entry: string
  /** 该半对外暴露的页面声明（仅 browser 半需要） */
  pages?: PageDeclaration[]
  /** 该半所需的注入服务列表 */
  inject?: string[]
}

export interface PageDeclaration {
  /** 路由路径，必须以 `/` 开头 */
  path: string
  /** 导航标题 */
  title: string
  /** 可选图标 */
  icon?: string
  /** 排序权重（默认 100） */
  order?: number
}
```

### 3.4 运行时导出

| 导出 | 说明 |
|---|---|
| `AuditClient`, `AuditResponse`, `RequestConfig` | Client 接口 |
| `Middleware`, `MiddlewareContext`, `Next` | 中间件类型 |
| `MAX_BODY_BYTES` | 默认 body 字节上限 |
| `Manifest`, `MANIFEST_VERSION`, `HalfEntry`, `PageDeclaration` | manifest 类型 |
| `validateManifest(json): Manifest` | JSON Schema 风格运行时校验 |
| `redactCredentials(headers): {headers: Record<string, string>, redacted: CredentialRef[]}` | 凭证脱敏（仅依据头名，不解析值） |
| `MAX_ZIP_BYTES = 4 * 1024 * 1024`（4 MB） | 单 zip 上限 |

---

## 4. packages/host

### 4.1 模块组成

```
packages/host/src/
├── server/
│   ├── http-server.ts          # 启动 HTTP server
│   ├── frontend-static.ts      # 托管 web dist（见 2.3.1）
│   ├── upload-route.ts         # POST /api/plugins 上传 zip
│   ├── plugin-route.ts         # GET /api/plugins 列表
│   ├── audit-route.ts          # GET /api/audit 记录查询
│   └── replay-route.ts         # POST /api/replay 触发重放
├── ws/
│   ├── ws-server.ts            # WebSocketServer + 心跳（变更 C）
│   ├── rpc-bridge.ts           # 协议帧 + pending + frame-size（变更 B）
│   └── browser-half-pusher.ts  # 向浏览器推送编译后 browser 半源码
├── client/
│   ├── audit-client.ts         # undici 实现 + 中间件链
│   ├── audit-middleware.ts     # 审计记录中间件
│   ├── credential-redact.ts    # 调用 core 的 redactCredentials
│   └── ring-buffer.ts          # 1000 条环形缓冲
├── plugins/
│   ├── loader.ts               # 编译 + 装载 + 重启恢复
│   ├── host-compiler.ts        # esbuild 编译 host 半
│   └── lifecycle.ts            # {id, pluginRunId, fiber} 注册表 + dispose 链（变更 A）
├── cordis/
│   ├── host-context.ts         # new Context() + 提供 client/audit 服务
│   └── builtin-plugins/
│       ├── audit-page.ts       # 内置 /audit 页面（实际上由 apps/web 渲染，这里只注册路由元数据）
│       ├── replay-page.ts      # 内置 /replay
│       └── plugins-page.ts     # 内置 /plugins
└── index.ts                    # main 入口：start({port, dataDir, open})
```

### 4.2 AuditClient 实现（undici）

```ts
class HostAuditClient {
  constructor(
    private dispatcher: Dispatcher,
    private middlewares: Middleware[],
    private buffer: AuditRingBuffer,
    private credentials: CredentialService,
  ) {}

  async request(req: MiddlewareContext): Promise<AuditResponse> {
    // 构造洋葱链
    const chain = compose(this.middlewares, async () => this.performFetch(req))
    const start = Date.now()
    try {
      const res = await chain()
      const latency = Date.now() - start
      // 审计中间件在外层已完成持久化
      return res
    } catch (err) {
      // 错误也由外层审计中间件记录
      throw err
    }
  }

  private async performFetch(req: MiddlewareContext): Promise<AuditResponse> {
    // undici fetch + 缓冲到 MAX_BODY_BYTES + JSON 检测
  }
}
```

**凭证脱敏时机**：在洋葱链最外层，`audit` 中间件之前先脱敏一次（在中间件构造 `MiddlewareContext` 时）。`authorization`、`cookie`、`x-api-key`、`x-auth-token`、`proxy-authorization` 头名匹配则值替换为 `{present: true, hash: sha256(value).slice(0,16)}`。

### 4.3 审计记录 Schema

```ts
// 持久化与通过 WS 推送的 record shape
interface AuditRecord {
  /** 单调 id（自增） */
  id: number
  /** Unix 毫秒时间戳 */
  ts: number
  /** 发起方标识 */
  initiator: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  /** 已脱敏的请求头 */
  reqHeaders: Record<string, string>
  /** 请求体（已脱敏后的字符串；JSON 自动 stringify；超过 MAX_BODY_BYTES 截断 + truncated:true） */
  reqBody: { text: string; truncated: boolean; bytes: number }
  /** 状态码；网络错误时为 0 */
  status: number
  statusText: string
  /** 已解压后的响应头 */
  resHeaders: Record<string, string>
  resBody: { text: string; truncated: boolean; bytes: number; json?: unknown }
  /** 总耗时毫秒 */
  durationMs: number
  /** 若该记录由 /replay 触发，指向被重放的原始记录 id */
  replayOf?: number
  /** 错误信息（若有） */
  error?: { name: string; message: string }
}
```

### 4.4 插件装载器（变更 A）

#### 4.4.1 上传流水线

```
POST /api/plugins (multipart/form-data, field: zip)
  → 解压到 data-dir/plugins/<plugin_id>-<upload_id>.zip
  → validateManifest(parsed)
  → esbuild 编译 host 半 → data-dir/cache/compiled/<plugin_id>-<hash>.mjs
    - bundle: true, platform: 'node', format: 'esm'
    - external: 仅 'cordis' 与 'node:' 内建
    - 内容 hash 来自 esbuild metafile JSON 的 outputs[0].hash
  → pathToFileURL(absoluteMjsPath).href → import()
  → ctx.plugin(hostHalfFn, { name: plugin_id })
  → await fiber.await()           ← 必须等待；错误异步抛
  → 注册 {id, pluginRunId: monotonicId(), fiber} 到 lifecycle map
  → 若失败：catch → await fiber.dispose() → throw
  → 返回 201 { id, pluginRunId, manifest }
```

#### 4.4.2 错误处理

- 启动失败：`catch` 块先 `await fiber.dispose()`，再把错误结构化返回给上传方
- `fiber.inject` 中声明的服务暂未就绪时：fiber 停在 PENDING 状态；run 响应携带 `waitingFor: ['serviceA']`；UI 显示 "waiting" 而非 "failed"
- 同 `pluginId` 二次上传/运行：先 `await retract(id)`，再 `loader.load(...)`，避免 `already registered` 抛错
- WS RPC invoke 与 host.call：必须带 `pluginRunId`，与注册表中的 `plugin.run?.pluginRunId` 对账；不等则 `{ok:false, error:{code:'stale-run'}}`

#### 4.4.3 停止 / 重启

- **Stop 路径**：`await fiber.dispose()`（dispose 是 AsyncDisposable，必须 await；disposers 逆序执行）
- **重启**：扫描 `data-dir/plugins/*.zip`，按文件名作 `{zip_path, plugin_id}` 持久化维度。对每个 zip 重新走 §4.4.1（**不复用 ctx 实例**；Context 在重启时是新建的）

### 4.5 WebSocket 协议（变更 B + C）

#### 4.5.1 协议帧

```ts
interface RpcFrame {
  /** 协议版本，固定 1 */
  v: 1
  /** 连接 epoch；服务端每次重新生成并下发 */
  generation: number
  /** 请求 id；首次事件 id 由发起方分配 */
  requestId: string
  /** 操作 */
  op:
    | 'snapshot.request'  // 客户端请求快照
    | 'snapshot.respond'  // 服务端响应快照
    | 'audit.append'      // 推送新审计记录
    | 'plugin.changed'    // 推送插件清单变更
    | 'rpc.invoke'        // 浏览器侧发起 host 方法调用（如 ctx.client.get）
    | 'rpc.result'        // 浏览器侧发起的 host 方法返回
    | 'browser-half.load' // 推送 browser 半编译产物（首次/重新装载）
    | 'browser-half.retract' // 浏览器半停止
    | 'error'
  payload: unknown
}
```

#### 4.5.2 硬约束

- **MAX_FRAME_BYTES = 16 * 1024 * 1024**（16 MB）
  - 入站：`TextEncoder().encode(data).byteLength > MAX_FRAME_BYTES` → `socket.close(1008, 'frame too large')`
  - 出站：`JSON.stringify(frame).length > MAX_FRAME_BYTES` → 改回 `{ok:false, error:{code:'payload/too-large'}}`
- **请求超时 30 秒**：`setTimeout(() => reject('timeout'), 30_000)`
- **socket close / generation 变更**：遍历 pending 表一次性 reject 所有 promise（错误码 `rpc/disconnected`），**绝不自动重放**；重连后上层各自重发幂等请求
- **陈旧响应拒绝**：收到的响应帧 `generation` 或 `op` 与 pending 表项不匹配 → reject 而非交付

#### 4.5.3 心跳（变更 C）

- **服务端**：每个 ws 监听 `'pong'` 清零 `missed`；`setInterval(30_000)` 对所有 `OPEN` socket 调 `socket.ping()`；`missed >= 2` 时 `socket.terminate()`；`interval.unref()` 以免阻塞进程退出
- **客户端**：不引入应用层 JSON 心跳（浏览器不能发 ws Ping）；重连退避由 `navigator.onLine` + `online/offline` + ws `onclose/onerror` 触发，按 `setNetworkAvailable(available)` 模式进入 disconnected 暂停重试，online 清退避立即重试

**契约文档明文**：`heartbeat = server-side ws Ping @30s, 2-miss terminate; client-side reconnect driven by navigator.onLine + ws close events, no app-level heartbeat`

#### 4.5.4 启动快照与重连对账

- **服务端** `ws.open` 时立刻发送 `snapshot.respond`（包含当前 audit 记录最后 id + 当前 plugin 清单）
- **客户端** 重连成功后发 `snapshot.request { sinceId? }`；服务端返回 `sinceId` 之后的 audit 记录增量 + 当前完整 plugin 清单
- 重连成功后客户端按当前清单 reconcile：
  - 清单中已不存在的 pluginRunId → 卸载 browser 半、移除页面与导航项
  - 清单中存在但本地未装载的 → 拉取 browser 半、装载
  - 旧插件（同名 id 不同 pluginRunId）→ 等价于 retract + load

### 4.6 Cordis 服务注册

```ts
const ctx = new Context()

// 统一 client 服务
class AuditClientService extends Service {
  constructor(ctx: Context) { super(ctx, 'auditClient') }
  // 通过 Service 子类提供；浏览器半也注册同名服务（host/client 共享 core 类型）
}

// 审计记录访问服务
class AuditStoreService extends Service {
  constructor(ctx: Context) { super(ctx, 'auditStore') }
  /** 全部记录（snapshot） */
  snapshot(): AuditRecord[]
  /** sinceId 之后 */
  since(sinceId: number): AuditRecord[]
  /** 按 id 取 */
  get(id: number): AuditRecord | undefined
}

// 插件清单服务
class PluginsService extends Service {
  constructor(ctx: Context) { super(ctx, 'plugins') }
  list(): PluginSummary[]
  stop(pluginRunId: string): Promise<void>
  remove(pluginRunId: string): Promise<void>
  load(zipPath: string): Promise<{ pluginRunId: string }>
}

// 凭证服务
class CredentialsService extends Service {
  constructor(ctx: Context) { super(ctx, 'credentials') }
  /** 按 hash 查活凭证（若有则用于重放时注入） */
  resolve(hash: string): string | undefined
}

ctx.plugin(AuditClientService)
ctx.plugin(AuditStoreService)
ctx.plugin(PluginsService)
ctx.plugin(CredentialsService)
```

### 4.7 内置 host 半插件

三个 core 页面（`/audit`、`/replay`、`/plugins`）的 host 半由 `packages/host` 内置提供，作为静态加载的 cordis 插件（在 host 启动时 `ctx.plugin`），不写入 `data-dir/plugins/`：

- `audit-page`：注册 `auditStore` 服务消费者占位 + 元数据（实际渲染在 `apps/web`）
- `replay-page`：注册 `replay` 工具服务；调用 `auditClient.request` 时强制 `initiator='replay:<recordId>'`
- `plugins-page`：注册 `plugins` 消费者占位 + 元数据

**重放请求构造**：`/replay` 表单构造一个修改后的 `RequestConfig` → 调用 `auditClient.request({initiator:'replay:<recordId>', ...})` → 走与正常请求完全相同的中间件链 → 审计记录含 `replayOf` 字段。

---

## 5. packages/client

### 5.1 模块组成

```
packages/client/src/
├── ws/
│   ├── connection.ts         # WS 连接 + 重连退避（navigator.onLine 驱动）
│   └── rpc.ts                # 协议帧收发 + pending 表
├── runners/
│   ├── browser-half-loader.ts  # 接收 ESM 源码 → blob URL → import
│   ├── shared-modules.ts       # 单一 React/cordis 实例共享
│   └── stop.ts                 # blob URL.revokeObjectURL + ctx.effect 清理
├── pages/
│   ├── pages-service.ts      # Pages Service（变更 D：prototype method）
│   └── react-router-bridge.ts # 注册表 → <Routes> 动态元素
├── audit/
│   └── client-proxy.ts       # AuditClient WS RPC 代理
├── cordis/
│   ├── browser-context.ts    # new Context() 浏览器侧
│   └── shared-context.ts     # 加载共享 React/cordis 实例的 import map
└── main.ts                   # apps/web 启动入口
```

### 5.2 浏览器半运行器

#### 5.2.1 接收编译产物

`ws-rpc` 收到 `browser-half.load { id, pluginRunId, code: string }` 帧：

```ts
// 构造 blob URL
const blob = new Blob([code], { type: 'text/javascript' })
const url = URL.createObjectURL(blob)
try {
  const mod = await import(/* @vite-ignore */ url)
  // 期待 mod.default = (ctx) => { ... }
  const halfFn = mod.default ?? mod.apply
  const fiber = ctx.plugin(halfFn, { name: id })
  await fiber.await()
  browserHalfRegistry.set(pluginRunId, { id, pluginRunId, fiber, blobUrl: url })
} finally {
  URL.revokeObjectURL(url)  // import 已缓存模块，URL 可释放
}
```

#### 5.2.2 React/cordis 单例保证（基于被反驳 finding 的有效建议）

为了让所有插件共享同一份 React/ReactDOM/cordis/AuditClient 实现：

- **esbuild 编译选项**：`external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'cordis']` + 这些包的别名指向同源绝对 URL
- **`apps/web/index.html`** 注入 `<script type="importmap">`，把上述包映射到 `apps/web/dist/assets/vendor/*.js`（这些 vendor 文件由 vite 构建一次，与宿主同源）
- **esbuild onResolve 插件**：把 bare specifier 改写为 import map 中的 URL

这保证：
1. 浏览器按 realm + URL 做模块表，所有插件看到同一份 React 实例
2. 不依赖任何特定 ESM 加载方案；只要 import map 准备好就工作

#### 5.2.3 Stop / Retract

- 收到 `browser-half.retract { pluginRunId }`
- `await fiber.dispose()`（必须 await）
- 内部 `pages.unregister(id)` 由 pages 服务自己通过 `ctx.effect` 完成清理（见 §5.3）

### 5.3 Pages 服务（变更 D — prototype method 规约）

```ts
// packages/client/src/pages/pages-service.ts
import { Service } from 'cordis'

declare module 'cordis' {
  interface Context {
    pages: Pages
  }
}

export class Pages extends Service {
  static readonly service = 'pages'
  declare readonly register: (entry: PageRegistration) => Disposable
  declare readonly unregister: (pluginId: string) => void
  declare readonly subscribe: (listener: () => void) => () => void
  declare readonly getSnapshot: () => readonly PageRegistration[]
}

// ★ 关键：方法体在原型上定义，不使用箭头函数（cordis caller-tracker 通过 this.ctx 追踪）
Pages.prototype.register = function (entry: PageRegistration): Disposable {
  const { pluginId, path, title, icon, order, Component } = entry
  // doRegister 必须挂到 caller fiber 的 effect 链
  return this.ctx.effect(() => {
    doRegister(this, pluginId, { path, title, icon, order, Component })
    return () => doUnregister(this, pluginId, path)
  }, 'pages.register')
}

Pages.prototype.unregister = function (pluginId: string): void {
  // 撤销该插件的所有页面注册
  const disposers = this.pluginsDisposers.get(pluginId)
  if (disposers) {
    disposers.forEach(d => d())
    this.pluginsDisposers.delete(pluginId)
  }
  notifyListeners(this)
}

Pages.prototype.subscribe = function (listener: () => void): () => void {
  this.listeners.add(listener)
  return () => { this.listeners.delete(listener) }
}

Pages.prototype.getSnapshot = function (): readonly PageRegistration[] {
  return Array.from(this.entries.values())
}
```

**禁止模式**（评审清单 grep 验证）：

```bash
rg -n 'register\s*=\s*\([^)]*\)\s*=>|register:\s*\(.*\)\s*=>' packages/client/src/pages/services.ts
# 必须为空
```

### 5.4 React Router 集成

- 使用 react-router v6 的 `<Routes>` + `<Route>` + `useRoutes()`
- 路由表来自 `pages.getSnapshot()`，订阅以触发重渲染
- 必须配置 `path="*"` 兜底路由（即使插件页面 dispose 期间也不出现白屏）
- 每个插件页用 `<PluginErrorBoundary pluginId onCrash={...}>` 包裹（仅作最佳实践，可选）

### 5.5 AuditClient 代理

```ts
class ClientAuditClientProxy {
  async get(url, config) { return this.rpc.invoke('auditClient.request', { method: 'GET', url, config }) }
  async post(url, body, config) { return this.rpc.invoke('auditClient.request', { method: 'POST', url, body, config }) }
  // ...
}
```

- 构造时绑定 `pluginRunId`（由运行器在装载时注入），所有请求自动带 `pluginRunId` 字段
- 失败错误码（如 `stale-run`、`payload/too-large`）转译为本地 `Error`

### 5.6 Cordis Context 初始化

```ts
// apps/web/src/main.ts
const ctx = new Context()

ctx.plugin(PagesService)
ctx.plugin(AuditClientProxy, { inject: ['rpc'] })
ctx.plugin(BuiltinPages)  // 渲染 /audit /replay /plugins 三个核心页

await ctx.lifecycle.init()  // 等待所有静态插件 ready
await connectRpc(ctx)        // 建立 WS，自动拉取 plugin 清单
```

---

## 6. 核心页面（core 自带）

| 路由 | 名称 | 渲染 | 数据来源 |
|---|---|---|---|
| `/audit` | 审计记录 | 表格 + 过滤 + 详情抽屉 | `auditStore.snapshot()` + `auditStore.since(id)` |
| `/replay` | API 重放 | 记录选择 → 编辑请求 → 并排对比响应 | `auditStore.get(id)` + `auditClient.request(initiator='replay:<id>')` |
| `/plugins` | 插件管理 | 上传区 + 列表（启停/移除/错误显示） | `plugins.list()` + `POST /api/plugins` |

**页面渲染职责划分**：

- **路由元数据**（path / title / icon / order）由 `apps/web` 端 `BuiltinPages` 静态注册
- **页面组件**位于 `apps/web/src/pages/`：
  - `AuditPage.tsx`：表格 + 过滤；详情抽屉显示完整 req/res headers 与 body
  - `ReplayPage.tsx`：选中记录 → 可编辑 method/url/headers/body 表单 → 重放按钮 → 并排显示 original vs replay（diff 视图）
  - `PluginsPage.tsx`：上传区（带 manifest 验证反馈）+ 插件列表

**重放 UX 护栏**（基于评审被反驳 finding 5 的有效内核）：
- 非幂等方法（`POST/PUT/PATCH/DELETE`）需二次确认（显示 host/method/url/body 前 1 KB）
- 原始记录若含被脱敏的敏感头（`authorization` 等）→ 重放页顶部展示橙色提示 "此请求包含凭证，重放将使用当前凭证服务的值"

---

## 7. 插件系统

### 7.1 zip 双半包格式

```
my-plugin.zip
├── manifest.json          # 见 §3.3
├── host.js                # 可选；Node 侧 ESM；默认导出 (ctx) => { ... }
└── browser.jsx            # 可选；浏览器侧 ESM+JSX；默认导出 (ctx) => { ... }
```

- 两半**至少其一**；可同时存在
- `host.js` 编译配置：`bundle: true, platform: 'node', format: 'esm', external: ['cordis']`
- `browser.jsx` 编译配置：`bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime', 'cordis']`，加上 §5.2.2 的 import map 与 onResolve 改写

### 7.2 清单校验

- 上传时 `validateManifest(json)` 运行时校验
- `id` 格式：`/^[a-z0-9-]+$/`
- `version`：semver（简化为 `\d+\.\d+\.\d+(-[\w.]+)?`）
- `pages.path`：以 `/` 开头，全局唯一
- `inject`：服务名（运行时由 host/client 各自核对实际可用服务）

### 7.3 生命周期

```
upload (.zip) → validateManifest → esbuild compile (host + browser) → 
  host: temp mjs import() → ctx.plugin → await fiber.await() → register {id, pluginRunId, fiber}
  browser: push code over WS → blob import → ctx.plugin → await fiber.await() → register
                              ↘ (concurrent, after host is up)
stop:   POST /api/plugins/{pluginRunId}/stop
  → host: await fiber.dispose() (triggers pages.unregister on browser via retract event)
  → browser: receives browser-half.retract → unregister pages + revoke blob URL
remove: POST /api/plugins/{pluginRunId}/remove
  → stop + delete from data-dir/plugins/
reload: stop + load (same pluginId with new version)
```

### 7.4 归因与凭证

- **归因**：`ctx.effect(() => ...)` 注册的 plugin 半，在 `auditClient.request` 时由调用栈确定 `initiator = pluginId`（通过 PluginContext 的 ctx scope 注入；运行器保证调用栈经包装 ctx）
- **重放归因**：`initiator = "replay:<recordId>"`，与正常插件调用区分
- **凭证**：audit 中间件在请求发出前执行脱敏（仅头名匹配）；重放时 host 的 `CredentialsService.resolve(hash)` 尝试注入当前活凭证；不可用则 `/replay` 页面顶部展示橙色提示并允许手动填入

### 7.5 信任模型

**MVP 不做硬沙箱**。明示：

- 插件代码运行在 host 进程同一 V8 realm 或浏览器页同一 realm
- 通过 manifest + size + 路径校验做基础保护
- 任何"插件无法绕过归因"的声称仅指"通过 `ctx.auditClient` 调用会被记录"；插件若使用 native `fetch`/`http.request` 等原生 API 仍可发起请求**但不被审计中间件记录**
- 文档明示信任边界："Treat a plugin like bash access to your dev box"

未来版本可考虑 dsh 风格的 `vm.createContext` + `new Function` 沙箱（MVP 不在范围内）。

---

## 8. 错误处理与边界情况

### 8.1 插件崩溃隔离

- cordis `ctx.plugin` 抛出由 `ctx.logger.error` 记录 + `fiber._error` 保留
- `/plugins` 页面展示错误态（read fiber state / message）
- **不允许**插件错误拖垮 host：所有装载操作在 try/catch 内

### 8.2 上传失败

| 阶段 | 失败 | 处理 |
|---|---|---|
| 解压 | zip 损坏 | 400 + 错误信息 |
| validateManifest | schema 不匹配 | 400 + 错误信息 |
| esbuild compile | 语法/类型错误 | 422 + 错误信息 + 编译日志 |
| import() | 模块解析失败 | 500 + 错误信息 |
| ctx.plugin + await | 运行时报错 | 500 + `await fiber.dispose()` + 错误信息 |

### 8.3 WebSocket 异常

- 客户端断开 → 服务端清理该 ws 对应的 pending 表项并 reject
- 心跳超时 → terminate → 客户端 reconnect
- 大帧 / 不匹配 generation → close + 客户端按 disconnect 处理

### 8.4 审计存储

- 内存 ring buffer（1000 条）默认；可选 JSONL append 到 `data-dir/audit/YYYY-MM-DD.jsonl`
- 满后覆盖最旧条目
- 进程重启后 ring buffer 清零（与 dsh 行为一致）；JSONL 保留

### 8.5 重放边界

- 原始记录 body 被截断 → 重放使用截断版本（一致性而非完美）
- 原始记录凭证不可恢复 → 重放页橙色提示，必须手动填入才能重放
- 流式响应（§3.1 范围外）→ 重放按钮禁用，提示"此记录不支持重放"

---

## 9. 测试策略

### 9.1 单元测试（vitest）

- `packages/core`：validateManifest、redactCredentials、Middleware 洋葱链
- `packages/host`：plugin loader（编译失败、运行时报错、stop/dispose）、audit middleware（凭证脱敏、JSON parse、truncation）、ws rpc bridge（timeout、frame size、generation mismatch）
- `packages/client`：pages service（register/unregister、prototype method 不被箭头污染）、browser half loader（blob URL revoke、esbuild options）

### 9.2 集成测试

编程式启动 host：
```ts
const host = await startHost({ port: 0, dataDir: tmpDir() })
const wsUrl = `ws://localhost:${host.port}/ws`
const browser = await connectRpc(wsUrl)

// 编译 + 上传示例插件
const zip = await buildExamplePlugin()
const { pluginRunId } = await host.upload(zip)

// 验证审计记录
const record = host.auditStore.snapshot().at(-1)
assert(record.initiator === `example-api:${pluginRunId}`)
assert(record.status === 200)

// 浏览器半验证
await browser.waitForPage('/example-page')
assert(await browser.findByText('Hello from plugin'))

// 停止 + 验证页面消失
await host.stop(pluginRunId)
await browser.waitForRouteRemoval('/example-page')
```

### 9.3 端到端（可选）

Playwright：
1. `npx api-audit` 启动
2. 浏览器打开 `http://localhost:4560`
3. 上传示例插件
4. 在 `/audit` 看到记录
5. 在 `/replay` 选中并重放
6. 在 `/plugins` 看到停止

### 9.4 评审清单（写进 CI）

```bash
# Pages 服务 prototype method 规约
! rg -n 'register\s*=\s*\([^)]*\)\s*=>|register:\s*\(.*\)\s*=>' packages/client/src/pages/services.ts

# core 零 cordis Context 增强
! rg -n "declare module ['\"]cordis['\"]" packages/core/src/

# esbuild 不允许 bundle 浏览器半的共享依赖
! rg -n "bundle: true" packages/client/src/runners/browser-half-loader.ts
```

---

## 10. 信任模型与限制

| 维度 | 状态 |
|---|---|
| 插件沙箱 | **无硬沙箱**；明示信任边界 |
| 凭证持久化 | MVP 不持久化凭证服务（CredentialsService 启动为空），重放需手动填入；JSONL 不写敏感头 |
| 多用户 | 单进程单用户；不设计认证 |
| HTTPS | 仅 localhost HTTP；生产部署请自行加反向代理 |
| 审计完整性 | 本地存储；可被 root 篡改；不在范围内 |
| 并发 | 单 host 进程；WS 可多浏览器连；record 推送给所有连上的浏览器 |

---

## 11. 实施路线（供后续 plan 细化）

按依赖顺序：

1. **packages/core**：类型 + validateManifest + redactCredentials + unit tests
2. **packages/host**：
   - HTTP server 骨架（仅 200 OK）
   - frontend-static 服务（按 §2.3.1 锚定）
   - AuditClient 实现 + 审计中间件 + ring buffer
   - WebSocket rpc-bridge（变更 B+C）
   - 插件装载器 + lifecycle（变更 A）
   - Cordis services 注册
3. **packages/client**：
   - WS connection + rpc
   - Pages 服务（变更 D）
   - browser half loader + shared modules（§5.2.2）
   - AuditClient 代理
4. **apps/web**：
   - Vite + React 18 + react-router v6 壳
   - 三个核心页面（Audit/Replay/Plugins）
   - import map + vendor chunk
5. **apps/cli**：
   - npx bin 入口
   - start/stop/open 浏览器
6. **plugins/example-api**：
   - 示例 zip 双半插件（调一个公共 API 展示数据）
7. **集成测试 + 评审清单 CI**

---

## 12. 后续可选（不在本期范围）

- 插件沙箱化（vm.createContext + new Function 闭包求值）
- 多 host 进程与远程 host 接入
- 凭证服务持久化与 OAuth flow
- HTTPS 与认证
- 审计页高级筛选（按 initiator/方法/状态/时间窗）
- 审计记录导出（HAR、OpenAPI diff）
- 插件签名与白名单
