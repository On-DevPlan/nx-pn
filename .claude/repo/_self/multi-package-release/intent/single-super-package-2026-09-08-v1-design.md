# Design: E — 合并为单一 super-package

> **Date:** 2026-09-08
> **Topic:** multi-package-release
> **类型:** intent doc（预测设计）
> **版本:** v1（相对：新建）
> **状态:** 试验
> **核心问题:** 如果放弃"family 多包"模型，把 `@flowot/nx-pn-*` 家族合并成一个 `nx-pn` 包（带 subpath exports），发布原子性问题会从根本上消失——但要付出"包名重构"的破坏性代价。这条路径值得评估吗？

## 原始请求（用户原话）

> 当前的多包发布方案有点麻烦 非常容易出现更新不及时
>
> PS D:\code\a_go\leaning\gs-ac\web> npx nx-pn init access
> ... npm error code ETARGET ... No matching version found for @flowot/nx-pn-storage-domain@^0.3.3. ...
>
>   /intent-capture-discuss 给出一些解决方案

后续通过 AskUserQuestion 选定方案 E："合并为单一 super-package"（作为策略级讨论存档）。

## 轻微重写版（仅修错别字与口癖）

> 当前的多包发布方案有点麻烦，非常容易出现更新不及时。
>
> （用户从外部项目跑 `npx nx-pn init access`，npm 报 ETARGET：`@flowot/nx-pn-storage-domain@^0.3.3` 在 registry 上找不到。）
>
> （多轮讨论选定方案 E：合并为单一 super-package，作为策略级讨论存档。）

## 本版要验证的假设

如果把 `@flowot/nx-pn-{core,client,host,storage,storage-json,storage-sqlite,storage-domain,web}` 全部合并到 `nx-pn` 一个 npm 包（用 `exports` 字段暴露 subpath），那么：
- (H1) 发布原子性问题不存在了——一个 npm publish 就是一切。
- (H2) 安装成本：用户从 10+ 个 `package.json` 条目减少到 1 个。
- (H3) **代价**：破坏性变更——所有外部消费者（包括 cordis 插件作者）需要改 import 路径。
- (H4) "plugins install by npm package name" 不受影响——那是 nx-pn 安装第三方插件的机制，不依赖 nx-pn 自己是多包。

## 一、设计原则

| # | 原则 | 体现 |
|---|---|---|
| 1 | **彻底解决发布原子性** | 单包 = 一次 publish = 没有漏发可能 |
| 2 | **subpath exports 兼容** | `nx-pn/host`、`nx-pn/storage` 等 subpath 让内部模块化依然清晰 |
| 3 | **保留 unscoped 入口** | `nx-pn` 这个 unscoped 名字作为对外主入口 |
| 4 | **接受破坏性变更** | 评估期明确告诉所有下游用户"v0.5.0 起包名重构" |

## 二、模块拆分

合并前后对比：

```
# 合并前（10 个公开包）
apps/cli           → @flowot/nx-pn
apps/web           → @flowot/nx-pn-web
apps/nx-pn         → nx-pn (unscoped alias)
packages/core      → @flowot/nx-pn-core
packages/client    → @flowot/nx-pn-client
packages/host      → @flowot/nx-pn-host
packages/hmr       → @flowot/nx-pn-hmr
packages/storage/storage          → @flowot/nx-pn-storage
packages/storage/storage-json     → @flowot/nx-pn-storage-json
packages/storage/storage-sqlite   → @flowot/nx-pn-storage-sqlite
packages/storage/storage-domain   → @flowot/nx-pn-storage-domain

# 合并后（1 个包 + subpath）
nx-pn/
  package.json (exports 字段定义所有 subpath)
  bin/nx-pn.mjs                    ← 原 apps/cli/bin/
  dist/web/                        ← 原 apps/web/dist/
  lib/
    core/        ← 原 packages/core/src/
    client/      ← 原 packages/client/src/
    host/        ← 原 packages/host/src/
    hmr/         ← 原 packages/hmr/src/
    storage/
      index.mjs  ← 原 packages/storage/storage/src/
      json.mjs   ← 原 packages/storage/storage-json/src/
      sqlite.mjs ← 原 packages/storage/storage-sqlite/src/
      domain.mjs ← 原 packages/storage/storage-domain/src/
```

## 三、数据流（关键场景）

### 场景 1：用户在外部项目用 nx-pn

```js
// 合并前
import { AuditClient } from '@flowot/nx-pn-core'
import { kv } from '@flowot/nx-pn-storage'
import { defineDomain } from '@flowot/nx-pn-storage-domain'

// 合并后
import { AuditClient } from 'nx-pn/core'
import { kv } from 'nx-pn/storage'
import { defineDomain } from 'nx-pn/storage-domain'
```

```bash
# 安装
npm i nx-pn
# 一次安装，全部 subpath 可用
```

### 场景 2：cordis 插件作者

```json
// 合并前：插件 manifest
{
  "name": "@scope/my-audit-plugin",
  "dependencies": {
    "@flowot/nx-pn-core": "^0.4.0"
  }
}

// 合并后：插件 manifest
{
  "name": "@scope/my-audit-plugin",
  "dependencies": {
    "nx-pn": "^0.5.0"
  }
}
```

### 场景 3：发布流程

```yaml
# 合并前：10 个 npm publish
# 合并后：1 个 npm publish
- name: Publish to npm
  run: |
    pnpm build
    pnpm pack --pack-destination .release
    npm publish .release/nx-pn-*.tgz --provenance --access public
```

## 四、关键决策

### D1：保留 `nx-pn`（unscoped）作为唯一对外入口 vs 改成 `@flowot/nx-pn`

- **结论：** 保留 `nx-pn` 作为主入口（与现状 unscoped alias 一致）。
- **理由：** `nx-pn` 已经存在且易记（CLI 命令名）；如果改成 `@flowot/nx-pn` 反而要重新建立品牌识别。
- **备选：** `@flowot/nx-pn`。被否决：unscoped 更简洁。

### D2：subpath 命名规则

- **结论：** 用 kebab-case 与现有 `nx-pn-hmr` 风格一致：`nx-pn/host`、`nx-pn/storage`、`nx-pn/storage-json`、`nx-pn/storage-domain`、`nx-pn/core`、`nx-pn/client`。
- **理由：** 简单、跟原包名去 scope 后一致、心智负担最小。
- **备选：** 嵌套命名（`nx-pn/storage/domain`）。被否决：与 storage 家族的"hub + 3 backends"模型不匹配——hub 和 backend 应该平级。

### D3：如何处理已发布的 `@flowot/nx-pn-*` 包

- **结论：** 选其一——
  - (a) 在 npm 上 `npm deprecate` 旧包，引导用户迁移；
  - (b) 保留旧包（不再发布新版本）作为"只读归档"。
- **推荐 (a)**：明确告知用户迁移路径，避免"安装时拿到 0.4.0 但实际是新版本"的混乱。
- **理由：** 项目当前外部用户极少（只有 `gs-ac/web` 等内部测试项目），迁移成本可控。

### D4：是否同步去掉 `pnpm-workspace.yaml` 的多包结构

- **结论：** 保留 monorepo 结构（pnpm workspace 仍然多包），但只发一个 npm 包。
- **理由：** monorepo 的开发体验价值（共享依赖、统一构建、本地 link）独立于"npm 上发几个包"。
- **替代：** 也可以改成单 package.json 的简单结构，但失去 nx 的增量构建能力。

### D5：版本号策略

- **结论：** 单包版本号，单一来源（仍然是 nx-pn/package.json）。
- **理由：** 合并后不存在"family 同步"问题。

## 五、接口 / 代码骨架

### `nx-pn/package.json`（合并后单一包）

```json
{
  "name": "nx-pn",
  "version": "0.5.0",
  "type": "module",
  "bin": {
    "nx-pn": "./bin/nx-pn.mjs"
  },
  "exports": {
    ".":              { "types": "./lib/index.d.ts",   "default": "./lib/index.js" },
    "./bin":          "./bin/nx-pn.mjs",
    "./core":         { "types": "./lib/core/index.d.ts",     "default": "./lib/core/index.js" },
    "./client":       { "types": "./lib/client/index.d.ts",   "default": "./lib/client/index.js" },
    "./host":         { "types": "./lib/host/index.d.ts",     "default": "./lib/host/index.js" },
    "./hmr":          { "types": "./lib/hmr/index.d.ts",      "default": "./lib/hmr/index.js" },
    "./storage":          { "types": "./lib/storage/index.d.ts",        "default": "./lib/storage/index.js" },
    "./storage/json":     { "types": "./lib/storage/json/index.d.ts",   "default": "./lib/storage/json/index.js" },
    "./storage/sqlite":   { "types": "./lib/storage/sqlite/index.d.ts", "default": "./lib/storage/sqlite/index.js" },
    "./storage/domain":   { "types": "./lib/storage/domain/index.d.ts", "default": "./lib/storage/domain/index.js" },
    "./package.json": "./package.json"
  },
  "files": [
    "bin",
    "lib",
    "dist/web",
    "!lib/**/*.tsbuildinfo"
  ]
}
```

### 工作区结构调整

```bash
# 单 package.json 模式（推荐）
$ tree nx-pn/
nx-pn/
  package.json             ← 单一对外包
  bin/nx-pn.mjs
  src/
    core/
    client/
    host/
    hmr/
    storage/
      index.ts
      json.ts
      sqlite.ts
      domain.ts
    web/                   ← React 源码
  dist/                    ← 构建产物
  tsconfig.json
  nx.json                  ← 仍可用 nx 管理内部任务

# 或保留 monorepo 但只发一个包（备选）
$ tree nx-pn/
nx-pn/
  pnpm-workspace.yaml
  apps/cli/                ← 内部用，最终产物拷到 root package.json
  packages/core/           ← 内部用
  packages/storage/...
  nx-pn-single/            ← 对外发包目录（由 build script 聚合）
    package.json
    lib/
    bin/
    dist/web/
```

### 发布 workflow（合并后）

```yaml
- name: Publish to npm (single)
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: |
    pnpm build
    pnpm pack --pack-destination .release
    tb=$(ls .release/nx-pn-*.tgz | head -1)
    npm view "nx-pn@$(node -p "require('./nx-pn-single/package.json').version")" version && echo "skip" && exit 0
    npm publish "$tb" --provenance --access public
```

## 六、职责边界

- 本方案**根本性改变**对外接口形态：所有 `@flowot/nx-pn-*` 包名消失。
- 不解决：(a) monorepo 内部的"多包开发体验"——但这与对外发包策略正交。
- 与方案 A/B/C 的关系：方案 A/B/C 都假定 family 仍多包；方案 E 是它们的**对立面**。如果选择 E，A/B/C 都不再需要。

## 八、改动范围（影响面）

| 模块 | 现状 | 改后 | 影响 |
|---|---|---|---|
| 所有 `package.json` 的 `name` 字段 | `@flowot/nx-pn-*` | 内部包名改为 `@nx-pn-internal/*`（不发布） | monorepo 内部仍然多包，但只有 root 包对外发布 |
| `pnpm-workspace.yaml` | 多包闭包 | 内部多包保留 + 一个聚合 build target | 几乎不变 |
| 所有 `.github/workflows/npm-publish.yml` | 10 个 publish 循环 | 1 个 publish | workflow 简化为单包 |
| README 的"Plugins"章节 | 提到 `@flowot/nx-pn-core` | 改为 `nx-pn/core` | 文档更新 |
| 所有 src 里的 `from '@flowot/nx-pn-core'` | 内部 cross-import | 改为 `from 'nx-pn/core'` | **源代码改动**——但只在 monorepo 内部 |
| 旧 `@flowot/nx-pn-*` 包 | 已发布 | npm deprecate 引导迁移 | 通知现有用户 |
| `apps/nx-pn/`（unscoped alias） | 独立转发包 | 删除 | 不再需要 alias |

## 九、迁移 / 实施路径

1. **Phase 1（评估期，1-2 周）**：发公告"v0.5.0 起包名重构"；收集下游用户反馈。
2. **Phase 2（迁移期，2-3 周）**：
   - 单 package.json 模式（推荐）或 聚合 build 模式（备选）
   - 内部所有 cross-import 改为 subpath
   - 旧包打 deprecate
3. **Phase 3（切换期，1 周）**：发布 v0.5.0 super-package；旧包不再发新版本。
4. **Phase 4（清理期，1 个月后）**：旧包 npm unpublish（如可能）或永久 deprecate。

整体迁移周期约 2 个月（不是 2 周）。

## 十、验收标准

| # | 验证项 | 方法 |
|---|---|---|
| 1 | 单包 publish 一次成功 | `pnpm publish` 后 registry 看到 `nx-pn@0.5.0` 一个包 |
| 2 | 所有 subpath 可独立 import | `node -e "import('nx-pn/core')"` 等都能解析 |
| 3 | bin 命令可执行 | `npx nx-pn --help` 工作 |
| 4 | web UI 可启动 | `npx nx-pn` → 浏览器打开 |
| 5 | 旧包 npm deprecate 提示迁移 | `npm install @flowot/nx-pn-core` 看到 deprecation warning |
| 6 | 至少 1 个下游项目（gs-ac/web）迁移成功 | gs-ac/web 升级到新 subpath 后 `npx nx-pn init access` 不再 ETARGET |

## 十一、待用户拍板的决策

| # | 决策 | 推荐 |
|---|---|---|
| 1 | 是否走 E 这条路 | **不建议**（推荐 A+B 长期方案）—— 破坏性变更成本高；当前 family 模型对外只是工具型包，受众窄，合并的实际收益（单包发布）已被方案 A+B+C 覆盖 |
| 2 | 如果走 E：单 package.json 还是聚合 build | 单 package.json（推荐）—— 简单直接；放弃 nx 的内部构建能力损失可控 |
| 3 | 如果走 E：旧包怎么处理 | npm deprecate（推荐）—— 引导迁移而非删除 |
| 4 | 如果走 E：是否保留 `@flowot/nx-pn*` 作为内部 monorepo 名 | 不保留（推荐）—— 内部叫 `@nx-pn-internal/*` 或不加 scope；避免混淆 |

## 十二、参考

- 现状文档：`project/2026-09-08-v1-status.md`（第 1 节包清单）
- 配套 design：方案 A/B/C 是本方案的对立面（不与本方案叠加）
- 类似实践：
  - `vite` 单包 + subpath（`vite/client`、`vite/node`）
  - `typescript` 单包 + subpath（`typescript/lib/tsc`）
  - `electron` 单包 + subpath（`electron/main`、`electron/renderer`）
- 包名重构经验：`vue` 从 2.x 单文件 → 3.x 单包 + subpath