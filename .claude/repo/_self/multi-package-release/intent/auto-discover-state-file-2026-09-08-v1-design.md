# Design: B — auto-discover + 发布状态文件

> **Date:** 2026-09-08
> **Topic:** multi-package-release
> **类型:** intent doc（预测设计）
> **版本:** v1（相对：新建）
> **状态:** 候选
> **核心问题:** 如何让新增包（如 `packages/hmr`）零配置自动加入发布列表；如何让"上次发布中途失败"的状况可被精准补发而不被"npm view 版本已存在"误判？

## 原始请求（用户原话）

> 当前的多包发布方案有点麻烦 非常容易出现更新不及时
>
> PS D:\code\a_go\leaning\gs-ac\web> npx nx-pn init access
> ... npm error code ETARGET ... No matching version found for @flowot/nx-pn-storage-domain@^0.3.3. ...
>
>   /intent-capture-discuss 给出一些解决方案

后续通过 AskUserQuestion 选定方案 B："auto-discover + state file"。

## 轻微重写版（仅修错别字与口癖）

> 当前的多包发布方案有点麻烦，非常容易出现更新不及时。
>
> （用户从外部项目跑 `npx nx-pn init access`，npm 报 ETARGET：`@flowot/nx-pn-storage-domain@^0.3.3` 在 registry 上找不到。）
>
> （多轮讨论选定方案 B：auto-discover + 发布状态文件，作为长期方案根治硬编码问题。）

## 本版要验证的假设

如果把 CI workflow 里两处硬编码的目录列表替换为"auto-discover 公开包 + 按 SHA 隔离的发布状态文件"，那么：
- (H1) 新增包不需要改 CI workflow——只要它在 `apps/*` 或 `packages/**` 内且 `publishConfig.access === "public"`，自动被纳入。
- (H2) 同一个 commit 重跑 CI 时，上次成功的包被精确跳过、失败的包被重试，不会因 registry 上的版本号被误判"已发布"。
- (H3) 维护者可以本地读 state 文件看到"上次发到哪、剩什么"。

## 一、设计原则

| # | 原则 | 体现 |
|---|---|---|
| 1 | **新增包零配置** | `tools/list-publishable.mjs` 是唯一包清单来源；CI 只调用它 |
| 2 | **per-SHA 状态隔离** | `.release/state.<commit-sha>.json` 记录"这次 run 的事实"，不受 registry 历史干扰 |
| 3 | **本地可读** | 维护者 `cat .release/state.<sha>.json` 即可知道上次发到哪、为啥失败 |
| 4 | **不修改语义** | 包名、版本策略、tag 流程都不变；只动"清单来源"和"幂等依据" |
| 5 | **与方案 A 协同** | 复用 `tools/list-publishable.mjs`；preflight 也消费同一份清单 |

## 二、模块拆分

新增/修改文件：

```
tools/list-publishable.mjs                 # 新增：auto-discover 公开包（与方案 A 共享）
tools/publish-state.mjs                    # 新增：发布状态机（load / save / mark）
.github/workflows/npm-publish.yml          # 替换两处硬编码目录为 auto-discover；增加 state 读写
```

职责：

- `list-publishable.mjs`：返回拓扑有序的公开包清单（含 `dir, name, version, deps`）。**这是清单的唯一真相来源**。
- `publish-state.mjs`：
  - `load(sha)` → 读 `.release/state.<sha>.json`，不存在则初始化空 state
  - `mark(sha, pkgName, status, meta)` → 记录 `{ published: [], failed: [], skipped: [] }`
  - `save(sha, state)` → 原子写回 state 文件
  - `pending(sha)` → 返回仍未成功的包（用于续跑）
- workflow：`Verify uniform family version` 和 `Publish to npm` 都改为"先 `list-publishable()` → 循环校验/发布"。

## 三、数据流（关键场景）

### 场景 1：首次发布 v0.4.0（state 不存在）

```
CI 触发 (commit abc123)
  → Verify uniform family version
       listPublishable() → 11 个公开包
       for each: 比对 version 是否等于 apps/cli/version
       全部一致 → pass
  → Preflight dependency closure（方案 A，可选叠加）
  → Publish to npm
       load('abc123') → 空 state
       pending('abc123') → 11 个全
       for each pkg:
         pack → publish
         on success: mark published
         on failure: mark failed (不中断循环，让其他包继续)
       save('abc123')
  → 上传 .release/state.abc123.json 作为 artifact
```

### 场景 2：续跑（上次中途 fail）

```
CI 触发（同 commit abc123 重跑）
  → Verify uniform family version (pass)
  → Preflight (pass)
  → Publish to npm
       load('abc123') → { published: [8 个], failed: [storage-domain, host] }
       pending('abc123') → [storage-domain, host]
       for each pending:
         pack → publish
         on success: mark published
       save('abc123')
  → 仅补发上次失败的 2 个
```

### 场景 3：未来加 `packages/foo`（新公开包）

```
开发者：在 packages/foo/ 加 package.json，publishConfig.access: "public"
commit → CI 触发
  → listPublishable() 现在返回 12 个（含 foo）
  → 自动纳入校验和发布流程
  → 无需修改 CI workflow
```

## 四、关键决策

### D1：state 文件的存储位置与生命周期

- **结论：** 写入仓库的 `.release/` 目录（gitignore），CI 把它上传为 artifact 保留 30 天；同时 commit 一次元数据到 git（只记录 SHA + 时间戳，不记录包内容）。
- **理由：** git 内留元数据可以让本地 `git log -- .release/` 看到每次发布的 SHA 时间线；artifact 保留完整状态供后续续跑。
- **备选：** 只存 artifact，不入 git。被否决：本地无法离线查询上次发到哪。

### D2：state 文件的清理策略

- **结论：** state 文件在对应 SHA 的 tag 创建后 7 天自动清理（CI 增加 cleanup job 或 workflow artifact TTL=7d）。
- **理由：** 长期保留会膨胀；tag 之后基本不再续跑。

### D3：state 是否要区分"已发布过"和"已成功 publish"

- **结论：** 是。`published: [{name, version, tarball, ts}]`、`failed: [{name, error, ts}]`、`skipped: [{name, reason, ts}]`。
- **理由：** 续跑时只看 `published`，跳过；其他都重试。失败原因保留供人工诊断。

### D4：`list-publishable.mjs` 的拓扑排序依据

- **结论：** 复用 `nx` 工具链已有的 `nx graph --file=...` 或基于 `dependencies` 做 Kahn's algorithm。
- **理由：** `nx.json` 已经有 `dependsOn: ["^build"]`，nx 自己维护依赖图；优先复用。
- **备选：** 手写拓扑排序（hardcoded 序）。被否决：与方案 E"未来包名可能变"不兼容。

### D5：state 文件是否需要进入 git 作为审计日志

- **结论：** 进入 git（轻量版）—— 只记 SHA + 包数 + 成功/失败汇总，不记 tarball 路径。
- **理由：** 让 `git log -- .release/` 成为"发布历史"的可查询视图。

## 五、接口 / 代码骨架

### `tools/list-publishable.mjs`

```js
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SCAN_DIRS = ['apps', 'packages']
const EXCLUDE_FROM_WORKSPACE = ['plugins'] // pnpm-workspace.yaml 已强制

export async function listPublishable() {
  const all = []
  for (const top of SCAN_DIRS) {
    const topPath = join(ROOT, top)
    if (!existsSync(topPath)) continue
    for (const sub of walk(topPath, 2)) {
      if (!sub.endsWith('/package.json')) continue
      const pkg = JSON.parse(readFileSync(sub, 'utf8'))
      if (pkg.publishConfig?.access === 'public') {
        all.push({
          dir: relative(ROOT, sub.replace('/package.json', '')),
          name: pkg.name,
          version: pkg.version,
          deps: Object.entries(pkg.dependencies ?? {})
            .filter(([n]) => n.startsWith('@flowot/') || n === 'nx-pn')
            .map(([n, v]) => ({ name: n, range: v }))
        })
      }
    }
  }
  return topoSort(all) // Kahn's algorithm based on deps
}
```

### `tools/publish-state.mjs`

```js
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const STATE_DIR = '.release'

export function load(sha) {
  const f = join(STATE_DIR, `state.${sha}.json`)
  if (!existsSync(f)) return { sha, published: [], failed: [], skipped: [], ts: new Date().toISOString() }
  return JSON.parse(readFileSync(f, 'utf8'))
}

export function save(sha, state) {
  mkdirSync(STATE_DIR, { recursive: true })
  const f = join(STATE_DIR, `state.${sha}.json`)
  // 原子写：先写 .tmp 再 rename
  const tmp = f + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, f)
}

export function markPublished(state, pkg, tarball) {
  state.published.push({ name: pkg.name, version: pkg.version, tarball, ts: new Date().toISOString() })
  state.failed = state.failed.filter(f => f.name !== pkg.name)
  state.skipped = state.skipped.filter(s => s.name !== pkg.name)
}

export function markFailed(state, pkg, error) {
  if (!state.failed.find(f => f.name === pkg.name)) {
    state.failed.push({ name: pkg.name, error: String(error).slice(0, 500), ts: new Date().toISOString() })
  }
}

export function pending(state, allPkgs) {
  const done = new Set([...state.published, ...state.skipped].map(p => p.name))
  return allPkgs.filter(p => !done.has(p.name))
}
```

### workflow（简化片段）

```yaml
- name: List publishable packages
  id: list
  run: node tools/list-publishable.mjs > .release/list.json

- name: Verify uniform family version
  run: |
    v=$(node -p "require('./apps/cli/package.json').version")
    node -e "
      const list = require('./.release/list.json');
      const drift = list.filter(p => p.version !== process.env.v);
      if (drift.length) { console.error('version drift:', drift); process.exit(1); }
    "

- name: Publish to npm (state-aware)
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
    STATE_SHA: ${{ github.sha }}
  run: |
    node tools/publish-all.mjs  # 调用 list-publishable + publish-state 组合
```

## 六、职责边界

- 本方案解决：(a) 硬编码目录列表；(b) 幂等跳过逻辑误判；(c) 新增包零配置。
- 不解决：(d) 漏发被提前发现——这是方案 A 的 preflight 职责。
- 不解决：(e) 声明式版本管理——这是方案 C 的 changesets 职责。
- 本方案与方案 A **强协同**：A 用 `list-publishable.mjs` 拿清单做预检；B 用同一个清单做发布。两者一起 ship 是最佳组合。

## 七、改动范围（影响面）

| 模块 | 现状 | 改后 | 影响 |
|---|---|---|---|
| `.github/workflows/npm-publish.yml` | 硬编码 9+10 个目录 | 调用 `node tools/list-publishable.mjs`；调用 `tools/publish-all.mjs` | workflow 体积 -30 行，逻辑全在工具脚本里 |
| `tools/list-publishable.mjs` | 不存在 | 新文件，~80 行 | 单一真相来源；本地可独立运行 |
| `tools/publish-state.mjs` | 不存在 | 新文件，~60 行 | state 文件 IO；可单元测试 |
| `tools/publish-all.mjs` | 不存在 | 新文件，~120 行 | 编排 list-publishable + publish-state + pack + publish |
| `.gitignore` | 无 `.release/` 规则 | 加 `.release/state.*.json` | state 文件不入 git 主体 |

## 八、迁移 / 实施路径

1. **Step 1**：写 `tools/list-publishable.mjs`，本地 dry-run 验证能列出当前 11 个公开包。
2. **Step 2**：写 `tools/publish-state.mjs`，加单元测试（mock fs）。
3. **Step 3**：写 `tools/publish-all.mjs`，集成 list + state + 原 pack/publish 循环。
4. **Step 4**：替换 CI workflow 里的硬编码目录为对 `publish-all.mjs` 的调用。
5. **Step 5**：观察第一次"新逻辑"跑通；如有失败用 state 文件验证续跑。

注意：本方案不阻塞 0.4.0 这次发布——维护者可以先按方案 A 补发 0.3.3 的 storage-domain，再单独抽时间实施 B。

## 九、验收标准

| # | 验证项 | 方法 |
|---|---|---|
| 1 | 新增 `packages/foo/` + `publishConfig.access: "public"` 不需要改 CI workflow | 本地加一个 dummy 包，跑 `list-publishable.mjs`，确认输出含 12 个 |
| 2 | 中途失败后重跑，只补发失败包 | 故意 fail 一次（断网/改 tarball 名），重跑；state 文件显示第二次只处理 1 个 |
| 3 | state 文件上传为 artifact | GH Actions UI 的 artifacts 列表能找到 `.release/state.<sha>.json` |
| 4 | `list-publishable` 返回的顺序是拓扑序 | 输出第一个是 `@flowot/nx-pn-storage`，最后一个是 `nx-pn` |
| 5 | 维护者本地可读 state | `cat .release/state.abc.json` 看到 `published[]` 含 tarball 路径 |

## 十、待用户拍板的决策

| # | 决策 | 推荐 |
|---|---|---|
| 1 | state 文件是否入 git？ | 否（推荐）—— `.gitignore` 排除；只上传 artifact |
| 2 | state 文件保留多久？ | artifact TTL 30 天 + tag 创建后 7 天 cleanup job（推荐） |
| 3 | 是否同时叠加方案 A 的 preflight？ | 是（推荐）—— 本方案让"自动重发"变得可能，preflight 让"提前发现问题"变得可能，两者正交 |
| 4 | 拓扑排序用 nx 自带还是手写？ | 手写 Kahn（推荐）—— 不引入 nx 在 CI 里运行；nx 已经在 build 阶段用过 |

## 十一、参考

- 现状文档：`project/2026-09-08-v1-status.md`（第 2、5 节）
- 配套 design：方案 A `preflight-dependency-closure-2026-09-08-v1-design.md`（共享 `tools/list-publishable.mjs`）
- CI 当前实现：`.github/workflows/npm-publish.yml`（line 55-69、line 89-121）