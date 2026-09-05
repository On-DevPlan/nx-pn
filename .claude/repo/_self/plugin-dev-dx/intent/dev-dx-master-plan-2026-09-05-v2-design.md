# dev-dx-master-plan v2 — 执行实施记录

> **Date:** 2026-09-05
> **Topic:** plugin-dev-dx
> **类型:** intent doc 2c master plan v2
> **版本:** v2(执行实施记录)
> **状态:** 候选(已实施)
> **前置:** v1 plan at `intent/dev-dx-master-plan-2026-09-05-v1-design.md`

---

## 原始请求(用户原话)

> OK 我现在确定了 我决定走 插件底座嵌入插件脚手架 支持快速启动, 然后构建可以分离,插件也支持指定运行的底座 进行热部署开发 ,npm可以上传 就说明本质是支持的 我也需要支持zip的上传 用于暂时取代插件市场 , 进行底层的大范围重构 查考koishi的插件架构体验,特别是run dev带有底座,build就是纯插件的设计模式,以及指定宿主底座 多插件同时开发在一个底座上的体验

## 轻微重写版

> OK,我现在确定了:我决定走"插件底座嵌入插件脚手架,支持快速启动"的路线;然后"构建可分离,插件也支持指定运行的底座进行热部署开发"。npm 既然可以上传,就说明本质是支持的;我也需要支持 zip 上传,用于暂时取代插件市场。进行底层的大范围重构。参考 koishi 的插件架构体验,特别是:`npm run dev` 带有底座 + `build` 就是纯插件 的设计模式,以及"指定宿主底座,多插件同时开发在一个底座上"的体验。

## 本版要验证的假设

**按 koishi 模板同构改造 nx-pn(脚手架内嵌底座 + 三层依赖 + peer 发布 + workspace 多插件 + HMR)后**,可以在不大改 host/client/web 协议面的前提下,消灭三痛点(时间不可控 / 版本漂移 / 命令行代理不专业),且能多插件同时开发在一底座上、保留 zip 作为非 npm 分发通道 —— 总改动面限于 init 模板、loader/通道入口、CLI 命令面、web UI 的 plugin 面板;host 与 client 不推翻。

---

## 一、实施时间线

### Phase 1 · 模板重构

**状态:** PASS (已实施)

**做了什么:**
- 删除旧 `apps/cli/templates/plugin-basic/` (8 文件单插件包)
- 创建新 `apps/cli/templates/plugin-workspace/` (workspace 模板)
- 重写 `apps/cli/src/init.ts` 为 workspace 生成器

**文件创建:**
```
apps/cli/templates/plugin-workspace/
├── package.json                          # devDeps: @flowot/nx-pn + esbuild/tsx/typescript
├── tsconfig.json                         # baseUrl: .; paths: "@flowot/plugin-*" → plugins/*/src
├── scripts/
│   ├── dev.mjs                          # probe :4560, spawn detached host, wait 30s
│   └── build.mjs                        # esbuild bundle → STORED zip (cordis externals check)
└── plugins/{{pluginId}}/
    ├── package.json                      # peerDependencies: @flowot/nx-pn-host; devDeps: @flowot/nx-pn-client
    ├── tsconfig.json                    # extends ../../tsconfig.json
    ├── manifest.json                     # schemaVersion: 1, id, version, title, halves
    ├── host.ts                          # 脚手架:boot counter + audit hello + hostCall endpoint
    └── browser.tsx                      # 脚手架:React page with useState counter
```

**关键代码片段:**

```json
// workspace root package.json
{
  "devDependencies": {
    "@flowot/nx-pn": "^{{version}}",
    "esbuild": "^0.24.0",
    "tsx": "^4.16.2",
    "typescript": "5.6.3"
  },
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "build": "node scripts/build.mjs"
  }
}
```

```json
// plugins/<id>/package.json (三层依赖)
{
  "peerDependencies": { "@flowot/nx-pn-host": "^{{version}}" },
  "devDependencies": { "@flowot/nx-pn-client": "^{{version}}" },
  "dependencies": {}
}
```

**文件删除:**
- `apps/cli/templates/plugin-basic/` (全部 8 文件)
- `plugins/devctr-kv/`, `plugins/echo/`, `plugins/example-api/` (旧插件目录,非 workspace 风格)

**构建状态:** PASS - `pnpm build` 成功

---

### Phase 2 · 类型同源 SDK 暴露

**状态:** PASS (已实施)

**做了什么:**
- 创建 `packages/client/src/plugin-types.ts`
- 从 `packages/client/src/index.ts` 导出 HostCtx 等核心类型

**文件创建:**
```
packages/client/src/plugin-types.ts    # HostCtx, PluginApplyFn, PluginModule, AuditClientConfig 等
```

**关键代码片段:**

```typescript
// packages/client/src/plugin-types.ts
export interface HostCtx {
  logger: { info(format: unknown, ...args: unknown[]): void; warn(...): void; error(...): void }
  on: { on(event: string, handler: (...args: unknown[]) => unknown): void; off(...): void }
  registry: unknown
  root: HostCtx
  baseUrl?: string
  effect<T>(fn: () => T): T
  extend(meta?: object): HostCtx
  isolate(name: string, label?: symbol): HostCtx
  auditClient: { get(url: string, config?: AuditClientConfig): Promise<AuditResponse>; ... }
  pluginStorage: { table(tableName: string): PluginNsTable | undefined }
  hostCall(event: string, payload?: unknown): Promise<unknown>
  [key: string]: unknown
}

export type PluginApplyFn = (ctx: HostCtx, config?: { name?: string }) => void | Promise<void>

export interface PluginModule {
  name?: string
  apply: PluginApplyFn
}
```

```typescript
// packages/client/src/index.ts (新增导出)
export type { HostCtx, AuditClientConfig, AuditResponse, HostCallResult, PluginApplyFn, PluginModule } from './plugin-types.js'
```

**构建状态:** PASS - TypeScript 编译通过

---

### Phase 3 · npm 通道 peer 校验 + link/file: 支持

**状态:** PASS (已实施)

**做了什么:**
- 在 `packages/host/src/plugins/loader.ts` 添加 `loadFromLink()` 方法
- 实现 peer dependency 版本校验 (semverSatisfies)
- 在 LoadResult 中添加 `peerWarning` 字段

**关键代码片段:**

```typescript
// packages/host/src/plugins/loader.ts
async loadFromLink(targetDir: string): Promise<LoadResult> {
  // (1) Read package.json
  const pkg = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf-8'))
  
  // (2) Peer dependency check
  let peerWarning: string | undefined
  const peerDeps = pkg.peerDependencies as Record<string, unknown> | undefined
  if (peerDeps && typeof peerDeps['@flowot/nx-pn-host'] === 'string') {
    const range = peerDeps['@flowot/nx-pn-host'] as string
    const hostVersion = getHostVersion()
    if (!semverSatisfies(hostVersion, range)) {
      peerWarning = `plugin "${id}" declares peerDependencies @flowot/nx-pn-host:${range} which does not include current host version ${hostVersion}`
      console.warn(`[plugin-loader] ${peerWarning}`)
    }
  }
  // ... (build zip, activate via load())
}
```

```typescript
// packages/host/src/plugins/loader.ts (semverSatisfies 实现)
function semverSatisfies(version: string, range: string): boolean {
  const clean = (v: string) => v.replace(/^[~^>=<*\s]+/, '').trim()
  const rangeClean = range.trim()
  const op = rangeClean.match(/^[~^>=<]+/)?.[0] ?? ''
  const rangeVer = clean(rangeClean)
  // 支持: ^x.y.z, ~x.y.z, >=x.y.z, >, <, <=, =, bare version
  // ...
}
```

**构建状态:** PASS - TypeScript 编译通过

---

### Phase 4 · workspace 多插件加载 + dev.mjs 快速启动

**状态:** PASS (已实施)

**做了什么:**
- 创建 `packages/host/src/server/workspace-config.ts`
- 修改 `packages/host/src/index.ts` (startHost) 集成 workspace 配置加载
- 在 loader.ts 添加 `loadFromWorkspace()` 方法

**文件创建:**
```
packages/host/src/server/workspace-config.ts    # loadWorkspaceConfig(cwd) → WorkspaceConfig
```

**关键代码片段:**

```typescript
// packages/host/src/server/workspace-config.ts
export async function loadWorkspaceConfig(cwd: string): Promise<WorkspaceConfig | null> {
  // 搜索顺序: koishi.config.yml → koishi.config.json → nx-pn.config.yml → nx-pn.config.json
  for (const file of CONFIG_FILES) {
    const configPath = join(cwd, file)
    try { await access(configPath, constants.R_OK) } catch { continue }
    const raw = await readFile(configPath, 'utf-8')
    const parsed = file.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw)
    const plugins = normalizePlugins(parsed.plugins, cwd)
    return { plugins, configPath }
  }
  return null
}
```

```typescript
// packages/host/src/index.ts (startHost 集成)
const wsConfig = await loadWorkspaceConfig(effectiveCwd)
if (wsConfig && doLoadFromConfig) {
  console.log(`[host] workspace config loaded from ${wsConfig.configPath} (${wsConfig.plugins.length} plugin(s))`)
  for (const entry of wsConfig.plugins) {
    await loader.loadFromLink(entry.path)
  }
}
```

```typescript
// packages/host/src/plugins/loader.ts (loadFromWorkspace)
async loadFromWorkspace(dir: string): Promise<LoadResult[]> {
  const entries = await readdir(dir)
  const results: LoadResult[] = []
  for (const subdir of entries) {
    const pkgPath = join(dir, subdir, 'package.json')
    try { await access(pkgPath) } catch { continue }
    try {
      const r = await this.loadFromLink(join(dir, subdir))
      results.push(r)
    } catch (err) {
      console.warn(`[plugin-loader] workspace load failed for ${subdir}:`, err.message)
    }
  }
  return results
}
```

**构建状态:** PASS - TypeScript 编译通过

---

### Phase 5 · HMR 移植

**状态:** DEFERRED (未实施)

**原因:** HMR 移植(koishi plugin-hmr 思想适配)需要较大重构,已实现的 Phase 1-4 已覆盖核心功能,HMR 作为后续迭代项。

**待做:**
- 新增 `@flowot/nx-pn-hmr` 包
- 实现模块图 reload + rollback
- 实现 workspace 源码直载场景下的热更新

---

### Phase 6 · 跨 workspace attach(可选) + zip 通道 peer 协商验证

**状态:** DEFERRED (部分实施)

**已实施:** zip 通道 peer 协商已内置于 `loadFromLink()` 的 `peerWarning` 逻辑。

**未实施:** 跨 workspace attach (dev.mjs --attach 模式)

---

### Phase 7 · 文档与生态同步

**状态:** PARTIAL (未完成)

**已完成:** 
- `plugin-types.ts` 文档注释完善

**未完成:**
- `.claude/skills/` 更新(需用户确认)
- 0.3.4 → 0.4.0 发版(版本号待定)

---

## 二、验收结果

### Case 1 · init 生成 workspace 模板

**方法:** 检查 `apps/cli/templates/plugin-workspace/` 结构 + 运行 init 逻辑

**实际输出:**
```
apps/cli/templates/plugin-workspace/
├── package.json           (devDeps 含 @flowot/nx-pn, scripts 含 dev/build)
├── tsconfig.json          (paths: "@flowot/plugin-*" → plugins/*/src)
├── scripts/dev.mjs        (probe :4560, spawn detached, wait 30s)
├── scripts/build.mjs      (esbuild → STORED zip, cordis externals check)
└── plugins/{{pluginId}}/
    ├── package.json       (peer @flowot/nx-pn-host, dev @flowot/nx-pn-client)
    ├── tsconfig.json
    ├── manifest.json
    ├── host.ts
    └── browser.tsx
```

**结果:** **PASS**

---

### Case 2 · 插件 build 产出 zip

**方法:** 检查 `scripts/build.mjs` 实现 + case3-test 产物

**实际输出 (case3-test):**
```
.claude/repo/_self/case3-test/
├── scripts/build.mjs          (esbuild bundle + STORED zip 组装)
├── plugins/case3-p/
│   ├── host.ts
│   ├── browser.tsx
│   ├── manifest.json
│   ├── host.js                (编译产物)
│   └── browser.js             (编译产物)
└── dist/case3-p.zip          (ZIP 产物, 存在)
```

**关键验证点:**
- cordis 外部化检查:编译后 host.js/browser.js 不含 `from 'cordis'` 或 `require('cordis')`
- React 外部化检查:browser.js 保留 `from 'react'`
- STORED zip:无压缩,CRC32 + local header + central directory + EOCD

**结果:** **PASS**

---

### Case 3 · workspace plugin 从 link 加载到 host

**方法:** 检查 `loadFromLink()` 实现 + `startHost()` 集成

**实际输出:**

`loadFromLink()` 完整实现了:
1. 读取 package.json
2. peer 依赖检查 (semverSatisfies)
3. manifest 构建 (api-audit.manifest 或 minimal manifest)
4. host.ts 编译 (esbuild, platform: node, external: cordis)
5. zip 组装 (manifest.json + host.js)
6. 通过 `load()` 激活 (dedup + namespace storage + fiber await)

`startHost()` 集成了:
```typescript
const wsConfig = await loadWorkspaceConfig(effectiveCwd)
if (wsConfig && doLoadFromConfig) {
  for (const entry of wsConfig.plugins) {
    await loader.loadFromLink(entry.path)
  }
}
```

**结果:** **PARTIAL** — 实现完成,端到端集成测试未执行 (case3-test 是手动构建,非 host 加载验证)

---

## 三、已知差距与未来工作

### 已实施但需验证
1. **端到端 init → npm install → npm run dev**:未在真实环境验证完整流程
2. **peer 版本冲突警告**:已实现但未验证 npm peer warning 场景
3. **多插件同时加载**:workspace 可容纳多个 plugins/ 子目录,但未验证同时激活

### 未实施(Deferred)
1. **HMR**:Phase 5 - 模块图 reload + rollback 未实现
2. **跨 workspace attach**:Phase 6 - dev.mjs --attach 模式未实现
3. **文档同步**:Phase 7 - skills 文档未更新
4. **发版**:版本号未从 0.3.x 升级

### 技术债务
1. **case3-test 的 build.mjs**:硬编码 monorepo 路径 `D:/code/a_js/proj/nx-pn`,生产模板需修复
2. **旧插件清理**:devctr-kv/echo/example-api 删除后,web UI 的 plugins 面板是否需要示例插件待确认

---

## 四、附:改动文件全清单

### 新增文件
```
apps/cli/templates/plugin-workspace/
├── package.json
├── tsconfig.json
├── scripts/dev.mjs
├── scripts/build.mjs
└── plugins/{{pluginId}}/
    ├── package.json
    ├── tsconfig.json
    ├── manifest.json
    ├── host.ts
    └── browser.tsx

packages/client/src/plugin-types.ts
packages/host/src/server/workspace-config.ts

.claude/repo/_self/case3-test/           (验证用测试 workspace)
├── package.json
├── tsconfig.json
├── scripts/dev.mjs
├── scripts/build.mjs
└── plugins/case3-p/
    ├── package.json
    ├── tsconfig.json
    ├── manifest.json
    ├── host.ts
    ├── browser.tsx
    ├── host.js
    ├── browser.js
    └── (compiled artifacts)
```

### 修改文件
```
apps/cli/src/init.ts                       (重写,生成 workspace 模板)
apps/cli/src/init.test.ts                  (测试更新)
apps/cli/src/main.ts                       (新增 --force 选项)
apps/cli/src/main.test.ts
packages/client/src/index.ts               (导出 plugin-types)
packages/host/src/index.ts                 (集成 workspace config 加载)
packages/host/src/plugins/loader.ts        (+ loadFromWorkspace, loadFromLink, semverSatisfies, buildZipForLink)
packages/host/src/__tests__/hot-add.e2e.test.ts (e2e 测试更新)
packages/host/package.json                (+ js-yaml 依赖)
pnpm-lock.yaml
```

### 删除文件
```
apps/cli/templates/plugin-basic/           (全部 8 文件)
plugins/devctr-kv/                        (全部 7 文件)
plugins/echo/                             (全部 7 文件)
plugins/example-api/                       (全部 7 文件)
```

### 统计
- **37 files changed**
- **905 insertions**
- **3,642 deletions**

---

## 五、参考

- `intent/dev-dx-master-plan-2026-09-05-v1-design.md` — v1 计划文档
- `intent/plugin-dev-dx-2026-09-05-intent.md` — 原始意图
- `intent/workspace-base-2026-09-05-v1-design.md` — workspace 基础设计
- `intent/base-version-negotiation-2026-09-05-v1-design.md` — 版本协商设计
- `intent/shared-install-base-2026-09-05-v1-design.md` — dsh 安装基座设计
- `project/koishi-init-model-2026-09-05-v2-concepts.md` — koishi 三层依赖洞察
- `project/compare_dev-dx-2026-09-05-v1-status.md` — 三方对比状态
- `project/compare_dsh-base-supply-2026-09-05-v1-status.md` — dsh 专项对比

---

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-05 | v2 | 初始版本 - 记录 Phase 1-4 实施结果,Phase 5-6 延期,Phase 7 部分完成 |
