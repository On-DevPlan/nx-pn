# 工程结构对比: nx-pn vs deepseek-harness

> **Date:** 2026-09-04
> **Topic:** monorepo-structure-comparison
> **类型:** project 状态文档 (compare)
> **版本:** v1
> **对比对象:**
> - **A · deepseek-harness (dsh)** — 参考项目,位于 `.claude/repo/deepseek-harness/`,代表成熟 monorepo 工程范式
> - **B · nx-pn (本项目)** — 当前仓库 `D:\code\a_js\proj\nx-pn`,代表小型 monorepo 工程范式

## 范围与口径

| 项 | 选取理由 |
| - | - |
| 仓库版本 | dsh 截取 `.claude/repo/deepseek-harness/package.json` 当前快照;nx-pn 截取 v0.1.0 发布后的 master (`1da017d`) |
| 维度数量 | 6 |
| 数据采集方式 | 只读扫描,未改动任何代码 |
| 不在本表呈现 | 性能数据、部署形态、API 兼容性 — 与「工程结构」主题无关 |

---

## 一、工作区拓扑 (Workspace Topology)

### 1.1 pnpm workspace 声明

| 配置项 | dsh | nx-pn (本项目) |
| - | - | - |
| `packages` 列表 | `vendor/*` + `packages/*/*` + `native/landlock-run` + `native/landlock-run/packages/*` + `apps/*` + `website` + `python/sdk-runtime` | `apps/*` + `packages/*` + `plugins/*` |
| 是否支持嵌套 | ✓ (`packages/*/*` 双层,如 `packages/host/frontend-static/`) | ✗ (单层,`packages/host`、`packages/host/frontend-static` 会同时匹配 — 当前未用) |
| `linkWorkspacePackages` | `true` (且通过 `overrides` 把 `vendor/cosmokit` 等显式 link 到 vendored 源) | 未设置 (pnpm 9 默认) |
| `overrides` 块 | 显式 2 项:`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` → `link:vendor/*` | 无 |
| `peerDependencyRules` | `typescript: '>=5 <7'` | 无 |
| `allowBuilds` | 9 项显式清单 (pnpm 10+ strictDepBuilds 默认开启,esbuild / lefthook / node-pty / koffi / @google/genai / protobufjs / node-addon-require-builtin / @deepseek-ai/dsh-subprocess-local / ...) | 无 (pnpm 9 默认宽松) |
| `patchedDependencies` | `node-pty@1.2.0-beta.15: patches/...patch` | 无 `patches/` 目录 |
| `minimumReleaseAgeExclude` | 19 条精确版本白名单 (覆盖 Anthropic SDK、codex SDK、pi-ai 等) | 无 |
| 注释密度 | 极高 (每条 `allowBuilds` / `minimumReleaseAgeExclude` 都标注原因) | 无 |

### 1.2 顶层目录

| 路径 | dsh | nx-pn (本项目) |
| - | - | - |
| `apps/` | `apps/cli` (含 `composition.md`、CLI 入口) | `apps/cli`、`apps/web`、`apps/nx-pn` (无 scope 别名包) |
| `packages/` | ~50 个领域包,按职责分两层:`packages/{domain}/{sub-domain}/` (如 `packages/host/webserver`、`packages/host/frontend-static`、`packages/client/web`) | 3 个包:`packages/core`、`packages/host`、`packages/client` |
| `plugins/` | 不存在此目录 (插件是发布到 npm 的包,通过 `dsh plugin --profile add <pkg>` 安装) | 2 个开发期示例插件:`plugins/echo`、`plugins/example-api` |
| `native/` | `native/landlock-run/` (Node native addon,Sandbox 启动器,自带构建脚本) | 不存在 |
| `vendor/` | `vendor/cosmokit/`、`vendor/schemastery/` (上游源码 fork,workspace 内 link) | 不存在 |
| `website/` | 独立站点 (文档站) | 不存在 |
| `python/` | `python/sdk-runtime/` (Python 运行时分发载体) | 不存在 |
| `docs/` | 大规模设计/参考/品牌/安全/贡献文档 | `docs/architecture.md`、`docs/superpowers/{specs,plans}/` |
| `tools/` | 不直接存在 (逻辑上对应 `scripts/`) | `tools/check-spec.sh` (单文件) |
| `scripts/` | `scripts/build.ts`、`scripts/release/*.ts`、~50 个 `gen-*` / `verify-*` 工具 | 不存在 (`pnpm build` 直接调 `nx run-many -t build`) |
| `patches/` | `patches/node-pty@1.2.0-beta.15.patch` | 不存在 |
| `.github/` | `workflows/` + `issue-management/` | `workflows/npm-publish.yml` (单文件) |

### 1.3 现象与差异

- dsh 的工作区声明承担了「供应链白名单 + 上游版本钉死」的双重职责 — `allowBuilds` 替代了 `onlyBuiltDependencies` 的开关语义,`minimumReleaseAgeExclude` 是 pnpm 10 默认 `minimumReleaseAge=2880min` 之下的精确豁免表。nx-pn 没有这些层,因为只用一个发布到 npmjs 公共注册表的纯 TS 包集,没有 vendored 框架、没有 native addon、没有自动安全护栏需求。
- dsh 用嵌套 `packages/*/*` 把「同领域多包」(如 `packages/host/` 下分 `webserver`、`frontend-static`、`plugin-inventory`) 收纳为同一目录树;nx-pn 把所有 host 内部模块平铺在 `packages/host/src/` 下,不存在「host 内部包」这种二等公民。

---

## 二、构建编排 (Build Orchestration)

### 2.1 总入口

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 总入口命令 | `tsx scripts/build.ts` (`--profile official` 等 profile) | `pnpm exec nx run-many -t build --parallel=1` (root `package.json` scripts.build) |
| 拓扑序控制 | `scripts/build.ts` 内部按 manifest 顺序调用 `build:lib:host` (host face) → `build:lib:client` (client face) → `build:web` (web frontend) → native 构建 → 单 exe 打包 | nx 的 `targetDefaults.build.dependsOn: ['^build']` 自动拓扑 (`^build` = 依赖先构建) |
| nx 是否介入 | ✗ (未使用 nx,自建 `scripts/build.ts` 编排 + tsdown/rollup/esbuild 直接调度) | ✓ (nx 19.8.6 作为编排器,但未用 nx 的 project graph / affected / generators) |

### 2.2 单包构建工具

| 包类型 | dsh | nx-pn (本项目) |
| - | - | - |
| Host 类 (Node 端,ESM 库 + cordis 服务) | `tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host` (tsdown 打包出 `lib/`) | `tsc -b` (仅 `packages/host`) |
| Client 类 (浏览器端) | `tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client` | `tsc -b` (仅 `packages/client`) |
| 前端 Web | `pnpm --filter @deepseek-ai/dsh-web-frontend run build` (vite + vendor bundles + vfs-image packer) | `node scripts/build-vendor.mjs && vite build` (apps/web 自带脚本) |
| 原生模块 | `native/landlock-run/packages/*` 单独 workspace,各自构建 node addon (C++) | 不存在 |
| TypeScript 配置分层 | `tsconfig.base.json` (共享)、`tsconfig.host.json`、`tsconfig.client.json` (face 分层) | `tsconfig.base.json` (所有包共用) |
| 运行时构建区分 | `DSH_BUILD_FACE=host` / `DSH_BUILD_FACE=client` 环境变量切换 build entry | 无区分 (各包 `tsc -b` 独立走) |

### 2.3 缓存与确定性

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 构建缓存 | 自实现 (未使用 nx cache),依赖 native build artifacts + content hash | nx cache (`targetDefaults.cache: true`) |
| `namedInputs` 排除 | 通过 `verify-built-package-invariants.mjs` 在 build 后比对产物 (而非构建期排除) | nx.json 显式 `production` input 排除 `**/?(*.)+(spec|test).[jt]s?(x).snap`、`tsconfig.spec.json`、`vitest.config.*` |
| 增量构建粒度 | 文件级 (tsc -b incremental) | 文件级 (tsc -b incremental + nx 输入哈希) |

### 2.4 现象与差异

- dsh 选择「自建编排脚本 + 显式 profile」而不是 nx,是因为它的拓扑不是 DAG 而是**分层 profile bundle**(`packages/bundle/{base,web-app,headless,acp-app,sdk-app,sdk-minimal}/`),同一份底层包在不同 profile 下走不同 entry 与 patch — 这不是 nx `dependsOn: ['^build']` 能优雅表达的。
- nx-pn 拓扑是 DAG (cli → host → {core, web} + web → {client, core}),nx 的 `^build` 足够覆盖,无需自建编排。

---

## 三、发布 / 打包流水线 (Release Pipeline)

### 3.1 版本管理

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 版本号分布 | 多家族 (families):`dsh` 家族、`vendor` 家族各自独立版本 (家族内统一版本) | 全家族统一版本 (`@flowot/nx-pn*` 五个包 + 别名 `nx-pn` 均为 `0.1.0`) |
| 版本 bump 入口 | `tsx scripts/release/bump.ts --family dsh` / `--family vendor` | git workflow 自动推断 (`apps/cli/package.json` 是版本源) |
| 校验 | `tsx scripts/release/verify.ts` | workflow 内的「Verify uniform family version」步骤 |
| 家族 schema | `scripts/release/families.ts` (单一来源,所有 family 在此声明) | 硬编码于 workflow 的 for-loop 列表 |

### 3.2 打包产物

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 单包 tarball 生成 | `pnpm pack` (workspace:^ → semver 重写由 pnpm 完成) | `pnpm pack` 同理 |
| 产物预检 | `scripts/release/verify.ts`、`scripts/release/verify-packed-install.ts` (解压到临时目录、`npm install`、`require()` smoke、`node -e "require('pkg/package.json')"` 等) | 本地 pack 后 `tar tzf | grep` 检查 (tsbuildinfo、sourcemap、_test-t 残留),CI 内无独立预检步骤 |
| 完整性验证 | `verify-built-package-invariants.mjs` (产物文件数、必含文件、依赖图封闭) | 仅靠 `pnpm pack` 默认 files 字段 |

### 3.3 发布动作

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 发布 trigger | `tsx scripts/release/publish.ts` (手动 + 校验) | push 到 master (`.github/workflows/npm-publish.yml`) |
| 发布工具 | `npm publish` per package | `pnpm pack` (workspace:^ 重写) → `npm publish --provenance --access public` |
| 并行/串行 | 由 release 脚本控制 (拓扑) | workflow for-loop 串行 (按 core → client → web → host → cli → alias) |
| 幂等检查 | `scripts/release/publish.ts` 内 (基于 families + npm view) | `npm view <name>@<version>` 前置检查 |
| 认证方式 | `NODE_AUTH_TOKEN` + OIDC (provenance) | `NODE_AUTH_TOKEN` + OIDC (provenance) — workflow `id-token: write` 权限 |
| Tag | release 脚本管理 (annotated tag,family 维度) | workflow 自动 `git tag -a v$VERSION -m "Release v$VERSION"` + push |

### 3.4 现象与差异

- dsh 的发布链路是一套独立的「release 工程」(8 个 TS 脚本 + 测试),家族化版本管理是核心;nx-pn 的发布链路是一条 GitHub Actions workflow,版本号从源包 `apps/cli/package.json` 读取并要求全员对齐,刻意保持最简。
- dsh 把 tarball 内容验证、依赖图封闭、解压后 `require()` smoke 都列为强制 gate (`verify-packed-install.ts`);nx-pn 的 CI 没有「解压后 smoke」这一步,仅依赖 pack 前的本地验证 (`packcheck`)。
- dsh 的家族化方案可让 vendor 与 dsh 家族以不同节奏 bump,适合「上游 fork 频繁、产品代码稳定」的场景;nx-pn 的单家族方案适合「全栈同节奏」的小型 monorepo。

---

## 四、前端分发形态 (Frontend Distribution)

### 4.1 产物结构

| 项 | dsh (`@deepseek-ai/dsh-web-frontend`) | nx-pn (`@flowot/nx-pn-web`) |
| - | - | - |
| 入口 (source) | Vite + React SPA shell | Vite + React SPA shell |
| 运行时 React 策略 | `external: ['react','react-dom','react-dom/client','react/jsx-runtime','react-router-dom']` + 自建 import map + 自建 vendor bundles | 同策略 (apps/web/vite.config.ts:27-33) |
| Vendor bundle 构建器 | Rollup + `@rollup/plugin-commonjs` + `@rollup/plugin-node-resolve` (写到 `public/vendor/`,vite 复制到 `dist/vendor/`) | Rollup + 同上 (apps/web/scripts/build-vendor.mjs) |
| 插件侧 React 隔离 | `loadBrowserHalf` (blob import) 经 import map 解析到 vendor 模块,「Exactly one React」 | 同策略 (`@api-audit/web` 注释提及) |
| 预览构建 | `build:preview` 包含 `dsh-pack-vfs-image` 输出 `dist/preview/vfs-image.tar.gz` | 无 preview |
| 运行时挂载 | 由 `packages/bundle/web-app` 在 profile 装配时注入 `dsh-host-frontend-static` 插件 → 解析 distIndex → 服务 SPA | 由 `packages/host/src/server/frontend-static.ts` 直接 `require.resolve('@flowot/nx-pn-web/package.json')` 解析 dist |

### 4.2 NPM 发布物

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| `files` | `["dist", "!dist/**/*.map", "!dist/preview.html", "!dist/preview"]` | `["dist", "!dist/**/*.map"]` |
| `exports` | `{"./dist/*": "./dist/*", "./package.json": "./package.json"}` | 同 |
| 运行时依赖 | 0 (react/react-dom/react-router-dom 在 devDeps,vendor bundles 内联在 dist) | 0 (同上) |

### 4.3 现象与差异

- 两边的「React 外部化 + import map + vendor bundle」策略完全一致,实现也几乎相同 (都是 rollup + CJS 插件,因为 esbuild 不能静态枚举 CJS re-exports)。这是 dsh 先发明,nx-pn 直接继承的模式 — nx-pn 的 `apps/web/scripts/build-vendor.mjs` 头注释里明确写了「为什么用 rollup 而非 esbuild」,解释与 dsh 一致。
- nx-pn 的 `packages/host/src/server/frontend-static.ts:35` 把 `'@api-audit/web'` 写为常量默认值,提供 `packageName` 选项覆盖 — 这与 dsh 的「web-app bundle 解析 distIndex 然后传给 frontend-static 插件」是同一抽象,只是 nx-pn 的 DI 更显式且更早定型。

---

## 五、代码一致性与验证基础设施 (Consistency Infrastructure)

### 5.1 自检脚本

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 总数 | ~50 个 `gen-*` / `verify-*` / `verify-*-catalog` / `verify-*-graph` 工具 (见 root `package.json` scripts) | 1 个:`tools/check-spec.sh` |
| 触发方式 | 各自为独立 npm script,部分由 `scripts/run-gates.ts` 编排 (`check:ci:linux-primary`、`check:ci:static` 等) | 1 个 npm script (`check:spec` → `bash tools/check-spec.sh`) |
| 实现语言 | TypeScript (tsx 执行) | Bash |
| 检查覆盖 (示例) | gen-tsconfig-paths / verify-tsconfig-paths、gen-cordis-catalog / verify-cordis-catalog、gen-client-catalog / verify-client-catalog、gen-tool-catalog / verify-tool-catalog、gen-config-catalog / verify-config-catalog、gen-persistence-catalog / verify-persistence-catalog、gen-scoped-events / verify-scoped-events、gen-doc-graphs / verify-doc-graphs、gen-module-graph / verify-module-graph、verify-runtime-closure、verify-application-entrypoints、verify-package-invariants、verify-built-package-invariants、verify-package-dependencies、verify-npm-install-layout、verify-optional-dependency-imports、verify-client-domain-graph、verify-cordis-config、verify-package-readme-model-experience、verify-package-licenses、verify-config-source-ownership、verify-node-next-types、verify-client-packages、verify-client-ui-i18n、verify-vendored-links、verify-package-paths、verify-third-party-notices、verify-skill-invocation-metadata、verify-mermaid、verify-translation-pairing、verify-translation-prompt、verify-archived-agent-notes、verify-agent-note-classification、verify-agent-note-format、verify-package-readme-limitations、verify-package-readme-model-experience、verify-doc-budgets、verify-doc-refs、verify-doc-site-fragments、verify-md-links、verify-md-wrap、verify-public-repository-links、verify-subsystem-pages、constraints (workspace 约束)、publint、hygiene、verify-built-package-invariants | check-spec.sh 检查:cordis 服务必须是原型方法、插件 host.ts 必须 `external: ['cordis']`、spec 违规 |

### 5.2 强制护栏

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| CI 阶段 | `check:ci:linux-primary`、`check:ci:static`、`check:ci:lint`、`check:ci:coverage`、`check:ci:snapshot`、`check:ci:artifacts`、`check:ci:consumers`、`check:ci:windows-blocking` (Wine) 等多个 gates | 无 CI lint/verify 步骤 (`.github/workflows/npm-publish.yml` 只跑 install/build/test/publish) |
| Pre-commit hook | lefthook (`lefthook.yml` + `scripts/install-lefthook.mjs`) | 无 |
| 文档治理 | verify-md-wrap、verify-md-links、verify-doc-site-fragments、verify-doc-budgets | 无 |

### 5.3 现象与差异

- dsh 的 verify-* 是「**manifest 单一来源**」的副产品 — cordis 服务、client 服务、tool、config、persistence、scoped-events、module graph 都是显式 catalog,verify-* 确保 catalog 与代码同步,代码与文档同步。这种治理规模在小 monorepo 是过度工程,但在 50+ 包 + 跨平台 native + Python 运行时 + 多 profile 装配的项目里,是避免 manifest 漂移的唯一可行手段。
- nx-pn 当前没有 catalog 概念,服务/路由都是手写 + 测试覆盖。一致性靠 `tools/check-spec.sh` 抓 spec violation (cordis arrow-class-field、`external: ['cordis']` 缺失等),规模匹配。

---

## 六、原生与运行时扩展 (Native / Runtime Extensions)

### 6.1 原生模块

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| Native addon | `native/landlock-run/` (Linux Landlock sandbox 启动器,node-addon,带原生构建脚本) | 无 |
| 跨平台 spawn | node-pty (1.2.0-beta.15) + 自打 patch (`patches/node-pty@...patch`) | 无 PTY 子进程 |
| 部署形态 | 单可执行文件打包 (deploy root `python/sdk-runtime/` 纯依赖清单,exe 闭包) | 仅 npm 包,无单 exe |

### 6.2 部署分发

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 主分发载体 | npm (`@deepseek-ai/dsh` 等 40+ 包) + Python runtime exe | npm (`@flowot/nx-pn*` 5+1 包) |
| 进程模型 | 长期运行的 `dsh` daemon + 一次性子命令 (`dsh web`、`dsh demo:inspector` 等) | `npx @flowot/nx-pn` 默认启动 web daemon;子命令 `add` / `uninstall` |
| 插件运行时 | 安装到 profile dir (类似 `~/.dsh/profiles/<profile>/`),通过 `dsh plugin --profile` 命令管理 | 安装到 `~/.api-audit/data/` (运行时数据目录),通过 `npx @flowot/nx-pn add <pkg>` 管理 |

### 6.3 现象与差异

- dsh 引入原生 + 跨平台 PTY 是为了提供沙箱安全与持久终端;nx-pn 不需要,因为它的威胁模型只覆盖「本地 cordis 插件隔离」(由 plugin loader 自身的 require 边界承担,不依赖 OS sandbox)。
- dsh 的 Python runtime deploy 是「同一份 closure 用不同壳分发」的策略,nx-pn 当前不需要这条路径。

---

## 七、整体规模对照

| 指标 | dsh | nx-pn (本项目) |
| - | - | - |
| 顶层 workspace glob 数 | 7 | 3 |
| Workspace 内包总数 | 50+ (按全 `packages/*/*` + `apps/*` + `vendor/*` + `native/*` + `python/*` + `website/*` 计数) | 6 (`apps/*`: 3;`packages/*`: 3) + 2 个 dev-only plugins |
| 已发布到 npm 的 `@<scope>/*` 包数 | ~40 (visible on registry) | 5 (`@flowot/nx-pn` + 4 个家族) |
| Native 模块 | 1 (landlock-run) | 0 |
| `scripts/` 下的 TS 工具 | ~80+ (含 gen-*/verify-*) | 0 |
| `scripts/release/*.ts` | 8 个 (bump、families、pack、process、publish、tarball、verify、verify-packed-install) + 1 个测试 | 0 (workflow 替代) |
| `.github/workflows/` | 多文件 | 1 (npm-publish) |
| `pnpm-workspace.yaml` 字段数 | 9 (packages、linkWorkspacePackages、overrides、peerDependencyRules、allowBuilds、minimumReleaseAgeExclude、patchedDependencies、注释) | 1 (packages) |
| TypeScript tsconfig 文件 | 4+ (`tsconfig.base.json`、`tsconfig.base.client.json`、`tsconfig.client.json`、`tsconfig.host.json`、`tsconfig.json`) | 1 (`tsconfig.base.json`) |

---

## 八、要点差异摘要 (供讨论起点,非建议)

| 维度 | dsh | nx-pn | 主要差异点 |
| - | - | - | - |
| 工作区 | 嵌套 + vendor + native + python + 多平台构建配置 | 平铺 apps/packages/plugins | dsh 用嵌套 `packages/*/*` 收纳同领域多包;nx-pn 把同领域代码放在一个包的 `src/` 下 |
| 依赖治理 | 9 类 pnpm 字段 (overrides、allowBuilds、patched、release-age...) | 1 个 `packages` 列表 | dsh 对供应链严格白名单 (上游 fork、native 包构建、补丁、安全护栏);nx-pn 默认宽松 |
| 构建编排 | 自建 `scripts/build.ts` + profile,无 nx | nx run-many 依赖图 | nx-pn 拓扑是纯 DAG → nx `^build` 够用;dsh 拓扑含 profile 分层装配 → 需自建 |
| 发布工程 | 8 个 release TS 脚本 + 家族化版本 | 单 workflow + 单一家族版本 | dsh 的家族化适合「vendor 与产品不同节奏」;nx-pn 「全栈同节奏」用单家族足够 |
| 一致性护栏 | ~50 个 gen-/verify- TS 工具 + lefthook + 多 stage CI gates | 1 个 bash check-spec + 无 hooks | dsh 的 catalog/verify 体系是「manifest 单一来源」的强制护栏,治理成本与规模正相关 |
| 前端分发 | dsh-web-frontend (vite + vendor + import map + vfs-image preview) | nx-pn-web (相同 vite + vendor + import map,无 preview) | 几乎相同模式,nx-pn 是 dsh 模式的精简继承 |
| 原生与运行时 | landlock + node-pty + 单 exe 部署 | 无 native,仅 npm 包 + Node 进程 | dsh 提供 sandbox + 持久终端;nx-pn 信任 cordis 边界 |

---

## 参考 (Reference)

- dsh 数据:`.claude/repo/deepseek-harness/{package.json,pnpm-workspace.yaml,scripts/release/*,tsdown.config.ts}`
- nx-pn 数据:`{package.json,pnpm-workspace.yaml,nx.json,tsconfig.base.json,apps/*/package.json,packages/*/package.json,.github/workflows/npm-publish.yml,tools/check-spec.sh}`
- dsh 前端包结构:`.claude/repo/deepseek-harness/apps/web/package.json`、`.claude/repo/deepseek-harness/packages/bundle/web-app/src/index.ts:174` (distIndex 解析)
- nx-pn 前端包结构:`apps/web/package.json`、`packages/host/src/server/frontend-static.ts:35` (packageName 默认常量)
- dsh 发布示例:`.claude/repo/deepseek-harness/scripts/release/publish.ts`、`scripts/release/verify-packed-install.ts`
- nx-pn 发布:`.github/workflows/npm-publish.yml`
