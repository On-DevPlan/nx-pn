# Compare: dsh（deepseek-harness）的发布序列 vs 本项目发布现状

> **Date:** 2026-09-08
> **Topic:** multi-package-release
> **类型:** project compare doc（外部项目实现 vs 本项目现状）
> **版本:** v1
> **约束:** 只记录两边当前是什么样、差在哪，不给建议。

## 原始问题

用户问："deepseekharness 也是这种每次都要重复发布全量的包嘛"——即 dsh 的多包发布是否也像本项目一样每次 release 全家族统一 bump、全量重发。

## 结论先行（一句话）

**是，也不是**：dsh 的**产品序列**（`packages/*/*` + `apps/*`，250 个包）与本项目同构——一个统一版本、全家族 bump、每次 release 都是全量新版本；但 dsh 把仓库拆成了**三条互不牵连的发布序列**（产品 / vendor / native），发产品不重发框架和原生包，vendor 序列内部甚至**按"目录是否变化"逐包决定发不发**。发布触发也从"push 自动发"改为"手动 dispatch from tag"。

## 对比对象

| | dsh（deepseek-harness，外部参考） | nx-pn（本项目现状，v0.4.1） |
|---|---|---|
| 仓库 | `.claude/repo/deepseek-harness`（本地快照） | 本仓库 |
| 权威说明 | `.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md`（设计说明，已实施） | `.github/workflows/npm-publish.yml` 注释 |

## 维度 1・家族版本策略

| | dsh | nx-pn |
|---|---|---|
| 产品家族版本 | **一个统一版本**（当前 `0.1.2-rc.1`），写入全部 250 个包（含 private 的）+ workspace root；CI 有等值校验 | **一个统一版本**（当前 `0.4.1`），写入 11 个包（10 公开 + 1 private hmr）；CI `Verify uniform family version` 步骤校验 |
| private 包 | 跟随 bump 但不 pack 不 publish（experimental 包只在 bump 时进家族） | hmr 跟随 bump，private，不发 |
| workspace 内部引用 | 全部 `workspace:^`，`check-workspace-constraints.ts` 强制，新包不能手写范围 | `workspace:^`，无强制脚本 |

## 维度 2・发布序列划分

| | dsh | nx-pn |
|---|---|---|
| 序列数 | **3 条独立序列**，各自的版本基线、tag、workflow：<br>① dsh 产品：非 experimental `packages/*/*` + `apps/*`，tag `dsh-v<ver>`<br>② vendor：9 个 `vendor/*` Cordis 框架包，**每包独立版本线**（跟上游 semver），tag `vendor-<pkg>-v<ver>`（每包一个）<br>③ native：`native/landlock-run/packages/*`，自己 0.0.x，tag `landlock-run-v<ver>` | **1 条序列**：全部 10 个公开包（storage 家族 + core/client/web/host/cli + unscoped alias）走同一个 publish 循环，一个 tag `v<ver>` |
| 划分动机（原文） | "Forcing them through one pipeline means every product release republishes the framework and the native binaries" | 未划分（storage 家族虽然无 cordis 依赖，但仍与产品同版本、同序列） |

## 维度 3・发布触发与权限

| | dsh | nx-pn |
|---|---|---|
| 触发 | **手动 `workflow_dispatch`，从 `dsh-v*` tag 上派发**；workflow 不监听 push/PR，"publication must always be an explicit, reviewed act"，绝不出现在 PR check 里 | **push 到 master 自动全量跑**（build → test → tag → publish 一条龙） |
| 版本落地 | 本地命令 `release:dsh`（bump.ts）bump + `pnpm install --lockfile-only` + **commit 进仓库**；人打 tag；**CI 从不写仓库**（workflow 只有 `contents: read`） | 版本由维护者手工改 package.json 提交；**CI 创建并推送 tag**（`contents: write`） |
| publish 时重打包 | 是——"it repacks the current tree before publishing so the bytes uploaded are exactly what this dispatch produced" | 是（pack 发生在同一 job 内） |

## 维度 4・幂等与"重发"判定（核心差异）

| | dsh | nx-pn |
|---|---|---|
| 判定依据 | **三态 integrity 比对**（`npm view <name>@<ver> dist.integrity --json`）：<br>① registry 缺该版本 → publish<br>② 存在且 **sha512 与本地 tarball 相同** → skip（同 artifact 重跑安全）<br>③ 存在但 **integrity 不同** → **fail**（"content changed without a version bump"，提示 bump 或查不可重现构建） | 二态存在性判定（`npm view <name>@<version> version`）：存在 → skip；不存在 → publish。不比对内容 |
| 是否读"本次发布清单" | 否——"Publish reads no tag and no manifest of 'what this release includes'"，逐 tarball 对 registry | 否——逐目录循环对 registry |
| 语义后果 | 版本相同但字节不同会被拦截；同字节重跑零副作用 | 版本相同内容不同的静默漂移检测不到（0.4.0 web 静默失败即属此类盲区） |

## 维度 5・变更检测（发哪些包）

| | dsh | nx-pn |
|---|---|---|
| 产品序列 | **每次全量**——家族统一 bump 后所有包都是新版本，不存在跳过 | **每次全量**——同理 |
| vendor 序列 | **只发变化的包**，且**无 state file，tag 即账本**：bump 读该包最新 `vendor-<pkg>-v*` tag，diff 包目录（`files` 选中的路径 + npm 必发的 `package.json`/`README*`/`LICENSE*` + 构建输入 `src/**`/`tsconfig*`）；有变化才 bump+发 | 无此机制（也不需要——单序列全量） |
| tag 语义 | "A tag is a commit pointer, not proof of publication"——bump 会向 registry 验证 tag 所指版本确实已发布，未发布则 fail 交人工处理（防"发布失败的 tag 被当成已发布而永久跳过"） | tag 在 publish 前创建推送；publish 失败会留下孤儿 tag（本会话 v0.4.0 曾实际发生） |

## 维度 6・发布可靠性工程

| | dsh | nx-pn |
|---|---|---|
| registry 写竞争 | 连续 publish 间隔 **≥2s**；瞬时错误（`E409/E429/E5xx/ETIMEDOUT/ECONNRESET/EAI_AGAIN`）**指数退避重试至 4 次**（"publishing several packages back to back outruns the registry's own processing and earns E409"） | 无间隔、无重试——`npm publish` 失败即 `set -e` 终止 |
| 失败后核对 | 每次重试前**重读 registry**："a reported failure can answer a write that landed anyway"，版本已存在且 integrity 一致记为成功 | 无——报错即止，不核对是否实际落库 |
| 私有包查询 | 无凭证机器上查询受限包会报告 gap 而非误判 | 不适用（全 public） |

## 维度 7・跨序列依赖校验

| | dsh | nx-pn |
|---|---|---|
| 发布前依赖闭包验证 | `release:verify` + `verify-packed-install`：**pack 输出互相安装验证**——"must not depend on the registry already carrying matching versions — one pull request may bump both families before either publishes"，故 vendor/landlock 的 tarball 也一并 pack 用于本地装 closure（只 publish `dist/npm`） | `tools/preflight-publish.mjs`（本会话新增）：registry 存在性 + 本次 publish 集合判定；不做 packed-install 互装验证 |
| 发布后探针 | installed-artifact probe（packed 装出来的实际产物探针） | 无 |

## dsh 产品序列一次典型发布流（现状描述）

```
本地: pnpm run release:dsh [major|minor|patch|显式版本]
      → 250 个包 + root 全部写同一版本, lockfile 更新, commit
人:   打 dsh-v<version> tag（merge 后）
CI:   release.yml（PR/push 时无凭证跑 pack+校验）
      release-publish.yml（手动 dispatch from tag）
        → install → release:verify → build → pack（产品+vendor+landlock for verify）
        → 逐 tarball 三态 integrity 判定 → publish（2s 间隔、4 次退避）
        → 汇总 "X published, Y already present"
```

## 本项目现状流（v0.4.1，本会话后）

```
维护者: 手工 bump 11 个包 package.json → commit → push master
CI:     npm-publish.yml 自动跑
        → build → test → 读版本 → family 校验 → preflight（新增）
        → tag 不存在则创建推送 → 10 目录循环 npm view 存在性 → pack+publish
（漏发时人工: npm-fix-publish.yml 手动 dispatch 补发）
```

## 两边实际发生过的坑（均为各自文档/本会话记录）

| 坑 | dsh 的记载 | nx-pn 的实际 |
|---|---|---|
| peerDeps `^0.0.1` 排除后续版本 | 设计说明 "the subtler blocker"（933 处手写范围） | 未出现（一直 workspace:^） |
| 发布失败但 registry 已落库 | 重试前重读 registry 处理 "landed despite a reported failure" | **本会话 v0.4.0 的 web 包**：CI 日志 `+ @flowot/nx-pn-web@0.4.0` 但 registry 无此版本，靠 fix-publish 补救 |
| 发布失败留下误导性 tag | bump 阶段向 registry 验证 tag 所指版本存在 | v0.4.0 tag 在 publish 前创建，web 漏发时 tag 已推 |
| 硬编码发布清单 | pack 按 family 对象（families.ts）枚举成员 | publish 循环硬编码 10 目录（preflight 已改为 auto-discover，publish 循环仍硬编码） |

## 参考

- dsh 设计说明：`deepseek-harness/.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md`（权威来源，含三条序列决策记录）
- dsh 实现：`deepseek-harness/scripts/release/{families,bump,verify,pack,publish,tarball}.ts`、`.github/workflows/release{,-publish,-vendor,-vendor-publish}.yml`、`pnpm-workspace.yaml`
- 本项目现状：`.github/workflows/npm-publish.yml`、`.github/workflows/npm-fix-publish.yml`、`tools/preflight-publish.mjs`
- 本主题既有文档：`../intent/etarget-incident-2026-09-08-intent.md`、`../project/2026-09-08-v1-status.md`