# Intent: 多包发布方案可靠性改造

> **Date:** 2026-09-08
> **Topic:** multi-package-release
> **类型:** intent doc（意图 + 现状根因 + 整体目标）
> **状态:** 候选

## 原始请求（用户原话）

> 当前的多包发布方案有点麻烦 非常容易出现更新不及时
>
> PS D:\code\a_go\leaning\gs-ac\web> npx nx-pn init access
> Need to install the following packages:
> PS D:\code\a_go\leaning\gs-ac\web> npx nx-pn init access
> Need to install the following packages:
> nx-pn@0.3.3
> Ok to proceed? (y) y
>
> npm error code ETARGET
> nx-pn@0.3.3
> Ok to proceed? (y) y
>
> npm error code ETARGET
> npm error notarget No matching version found for @flowot/nx-pn-storage-domain@^0.3.3.
>
> npm error code ETARGET
> npm error notarget No matching version found for @flowot/nx-pn-storage-domain@^0.3.3.
> npm error notarget In most cases you or one of your dependencies are requesting
> npm error notarget a package version that doesn't exist.
> npm error notarget No matching version found for @flowot/nx-pn-storage-domain@^0.3.3.
> npm error notarget In most cases you or one of your dependencies are requesting
> npm error notarget a package version that doesn't exist.
> npm error notarget No matching version found for @flowot/nx-pn-storage-domain@^0.3.3.
> npm error notarget In most cases you or one of your dependencies are requesting
> npm error notarget a package version that doesn't exist.
> npm error A complete log of this run can be found in: C:\Users\MINISFORUM\AppData\Local\npm-cache\_logs\2026-09-08T09_14_39_545Z-npm error A complete log of this run can be found in: C:\Users\MINISFORUM\AppData\Local\npm-cache\_logs\2026-09-08T09_15_17_372Z-debug-0.log
> PS D:\code\a_go\leaning\gs-ac\web>
>
>
>
>
>
>   /intent-capture-discuss 给出一些解决方案

后续通过 AskUserQuestion 确认：4 个方向各出一份 design doc；主题目录 `multi-package-release`。

## 轻微重写版（仅修错别字与口癖）

> 当前的多包发布方案有点麻烦，非常容易出现更新不及时。
>
> （用户从外部项目 `gs-ac/web` 跑 `npx nx-pn init access`，npm 报 `ETARGET`：`@flowot/nx-pn-storage-domain@^0.3.3` 在 registry 上找不到。）
>
> （多轮讨论选定方案 A：依赖闭包预检；方案 B：auto-discover + state file；方案 C：迁移到 Changesets；方案 E：合并为单一 super-package。每个方向各自产出一份 design doc，主题目录 `multi-package-release`。）

## 背景与动机

最近一次 `0.3.x` 发布把 `@flowot/nx-pn-storage-domain` 漏在了 registry 之外（`git log` 显示 `8cfafb1 chore(release): publish storage-domain@0.3.3 + dev workflow polish` 是补救提交）。外部项目 `gs-ac/web` 跑 `npx nx-pn init access` 时 npm 解析 `nx-pn@0.3.3` 的依赖图 → `@flowot/nx-pn-storage-domain@^0.3.3` 不存在 → `ETARGET`。当前 `master` 工作区已经把所有 11 个包升到 `0.4.0`，但 `v0.4.0` tag 尚未创建、registry 最新版本仍是带缺陷的 `0.3.3` 残缺快照。

这是历史第二次出现同类事故（`2f1fbbd chore(release): 0.3.1 storage family (missed by first bump commit)`），说明当前发布流程存在结构性缺陷，不只是偶然操作失误。

## 目标

- **G1**：发布流程具备"发出去的就是完整的"原子性保证——任何 commit 推到 `master` 触发发布后，registry 上的 `@flowot/nx-pn*` family 必须自洽（每个被发布的包的依赖都能在 registry 上找到对应版本）。
- **G2**：新增包（如 `packages/hmr`）零配置自动加入发布列表，不再需要手动改 CI workflow。
- **G3**：发布失败可重入且不留下半残状态——同一个 commit 重跑能补齐上次的失败点，且不会因为"上次版本号被视作已发布"而卡死。
- **G4**：为团队未来长期维护这个 monorepo 留出迁移到声明式变更管理（changesets）的清晰路径。

## 约束与边界

- 现有 push-to-master 自动发布的工作流必须保持：维护者习惯了"代码合并即发布"。
- 所有改动都先以"最小侵入"为前提评估；任何破坏 npm 上 `@flowot/nx-pn*` 包名兼容性的方案必须在 README 显式标注迁移窗口。
- `plugins/*` 仍必须排除在 workspace 闭包之外（当前 `pnpm-workspace.yaml` 已强制；不可逆原则）。
- 不修改任何源代码文件（受 intent-capture-discuss 铁律约束）；所有产物仅为 markdown 文档。
- 现状盘点和方案设计文档分离：现状文档（`project/`）不写建议；方案文档（`intent/*-design.md`）承载设计与建议。

## 关键决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 文档归属 | 主题目录 `multi-package-release/`，4 份独立 design doc 并存 | 用户在 AskUserQuestion 明确选定 4 个方向；每个方向是独立可采纳的设计，互不排斥 |
| 现状文档 | `project/2026-09-08-v1-status.md` 仅记录 CI 现状与漏发历史，不写建议 | 受铁律 4 约束，盘点类文档只描述"是什么" |
| 方案排序 | 4 份 design doc 按"侵入度从小到大"排序（preflight → auto-discover → changesets → 合并） | 给维护者一个清晰的"先做什么、再做什么"路径 |
| 方案 A 优先级 | 列为"今天 ship 止血" | 直接对应"现在 0.4.0 怎么发出去不出事故"的紧迫需求 |
| 方案 E 决策点 | 作为策略级讨论存档，不立刻执行 | 涉及破坏性变更（包名重构），需要更长决策周期 |

## 后续 design doc 索引

| design-name | 标题 | 状态 |
|---|---|---|
| preflight-dependency-closure | A：依赖闭包预检 | 候选 |
| auto-discover-state-file | B：auto-discover + state file | 候选 |
| changesets-adoption | C：迁移到 Changesets | 试验 |
| single-super-package | E：合并为单一 super-package | 试验 |

## 待定问题

- 方案 B 的 `.release/state.<sha>.json` 是否需要上传为 GH Actions artifact，还是用 commit message / branch ref 持久化？
- 方案 C 是否需要配套引入 `nx release`（与现有 Nx 工具链复用），还是直接用 `@changesets/cli`？
- 方案 E 合并后是否仍保留 `nx-pn` 这个 unscoped 名字作为对外主入口，还是改用 `@flowot/nx-pn` 单包？