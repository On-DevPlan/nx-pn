# Design: C — 迁移到 Changesets

> **Date:** 2026-09-08
> **Topic:** multi-package-release
> **类型:** intent doc（预测设计）
> **版本:** v1（相对：新建）
> **状态:** 试验
> **核心问题:** 用声明式 changeset 替代当前"从 `apps/cli/package.json` 读 version 硬编码"的发布模式，让版本管理、CHANGELOG 生成、依赖联动全部自动化，避免人为遗漏。

## 原始请求（用户原话）

> 当前的多包发布方案有点麻烦 非常容易出现更新不及时
>
> PS D:\code\a_go\leaning\gs-ac\web> npx nx-pn init access
> ... npm error code ETARGET ... No matching version found for @flowot/nx-pn-storage-domain@^0.3.3. ...
>
>   /intent-capture-discuss 给出一些解决方案

后续通过 AskUserQuestion 选定方案 C："迁移到 Changesets"。

## 轻微重写版（仅修错别字与口癖）

> 当前的多包发布方案有点麻烦，非常容易出现更新不及时。
>
> （用户从外部项目跑 `npx nx-pn init access`，npm 报 ETARGET：`@flowot/nx-pn-storage-domain@^0.3.3` 在 registry 上找不到。）
>
> （多轮讨论选定方案 C：迁移到 Changesets，作为长期声明式版本管理方案。）

## 本版要验证的假设

如果把当前"读 `apps/cli/package.json` + 硬编码目录 + pnpm pack/npm publish"的发布流程换成 `@changesets/cli`，那么：
- (H1) 每次 PR 强制附带 `.changeset/<branch>.md` 声明"哪些包要 bump、bump 类型"，漏声明就在 CI 阶段 fail。
- (H2) changesets 自动算出版本联动（某个包 major 升级会带动依赖它的下游 minor/patch），不再需要"手动统一 family version"。
- (H3) CHANGELOG.md 自动生成，发布日志零成本维护。
- (H4) 与现有 Nx 工具链兼容——可选用 `nx release` 作为 changesets 的 nx 适配层。

## 一、设计原则

| # | 原则 | 体现 |
|---|---|---|
| 1 | **声明式优先** | 变更通过 `.changeset/*.md` 表达，CI 自动算版本、publish、生成 changelog |
| 2 | **PR 阶段强制** | 在 PR check 加 "changesets 存在性 + 格式" 校验，缺 changeset 不能 merge |
| 3 | **依赖联动** | 用 `@changesets/cli` 的 linked 模式：family 内一个包升级会联动其他包 |
| 4 | **可逆性** | 仍保留 `pnpm pack` + `npm publish` 的硬能力入口（changeset 背后就是调它们） |

## 二、模块拆分

新增/修改文件：

```
.changeset/                                # 新增目录
  config.json                              # changeset 配置（linked 模式）
  README.md                                # 给贡献者的 changeset 编写指南
  <branch-name>-<n>.md                     # 每次 PR 必带的 changeset 文件
.github/workflows/
  changesets-pr-check.yml                  # 新增：PR 阶段校验 changeset
  npm-publish.yml                          # 改造：删除硬编码，调用 pnpm changeset publish
tools/
  list-publishable.mjs                     # 仍保留（changesets 不替代这个能力）
  preflight-publish.mjs                    # 仍保留（方案 A 的预检）
package.json (root)                        # 加 scripts: "changeset": "changeset"
```

## 三、数据流（关键场景）

### 场景 1：开发者提交带版本变更的 PR

```
开发者 git checkout -b feat/new-thing
  → 修改 packages/host/src/foo.ts
  → pnpm changeset
       提示：哪些包？→ host
       bump 类型？→ minor
       摘要？→ "add foo.ts"
       生成 .changeset/feat-new-thing-abc.md:
         ---
         "@flowot/nx-pn-host": minor
         ---
         add foo.ts
  → 提交 PR
  → CI 触发 changesets-pr-check.yml
       检查 changeset 文件存在 → pass
       解析 frontmatter 格式 → pass
       (link 校验：所有被引用的包都在 list-publishable 里)
  → merge to master
```

### 场景 2：master 触发自动发布

```
push to master
  → CI 触发 npm-publish.yml
  → pnpm changeset version
       读取所有 .changeset/*.md
       按 linked 模式算版本
       host: 0.3.3 → 0.4.0 (因为 host 升级带 core/client/cli 联动 minor)
         （linked 配置下，host 的 minor 触发 host 自身 minor + 依赖 host 的包 patch）
       更新各 package.json 的 version
       删除已消费的 .changeset/*.md
       更新 CHANGELOG.md（每个包独立）
  → pnpm changeset publish
       遍历所有 version bump 过的包
       调 pnpm pack → npm publish --provenance
       （内部就是当前 Publish to npm 步骤的逻辑）
  → 整体原子提交 "Version Packages"
  → push 这个 commit + tag 一起
```

### 场景 3：依赖联动（linked 模式示例）

```
当前所有 family 包版本：0.3.3
开发者提交：host minor 升级（因为接口变更）
  → .changeset/feat-host-api.md:
      ---
      "@flowot/nx-pn-host": minor
      ---
      add new event API

changeset version 时算出版本联动：
  host: 0.3.3 → 0.4.0
  cli (depends on host): 0.3.3 → 0.3.4 (patch，修复对齐 host@0.4.0)
  web (depends on host): 0.3.3 → 0.3.4
  nx-pn (alias of cli): 0.3.3 → 0.3.4
  storage-* (不依赖 host): 不变
```

## 四、关键决策

### D1：用 `@changesets/cli` 还是 `nx release`

- **结论：** 优先评估 `nx release`（项目已经在用 nx），fallback 到 `@changesets/cli`。
- **理由：** `nx release` 在 19.x 已经支持 changesets 后端，复用 nx 项目图谱；但 nx release 的变化频繁（19.x → 20.x 重写过 release API），可能存在踩坑风险。
- **备选：** 直接 `@changesets/cli`。被作为 fallback——更稳定但少与 nx 集成。

### D2：linked vs fixed 模式

- **结论：** **fixed 模式**——family 内所有包保持同一版本号。
- **理由：** 与当前约定一致（Verify uniform family version）；未来若想独立版本可切换到 independent 模式。
- **备选：** independent 模式（方案 D 的方向）。被否决：本设计是方案 C 的核心，与方案 D 的独立版本目标正交。

### D3：changeset 文件是否进入 PR 检查

- **结论：** 是。PR 必须含 changeset 才能 pass CI（除非 PR title 含 `chore:` 或 `docs:` 这种不需要发版的标签）。
- **理由：** 这是 changesets 工作流的最大价值——把"是否需要发版"从人脑搬到 PR 流程。

### D4：CI 是用 `pnpm changeset publish` 还是 `changeset version` + `pnpm publish`

- **结论：** 用 changeset 的 `version` 子命令算版本，再用其内嵌 `publish` 子命令发布（不要拆成两步）。
- **理由：** changesets 的 `publish` 子命令已经知道"哪些包版本变了"，拆成两步会让两者状态不同步。

### D5：迁移期如何处理已经在工作区的 v0.4.0

- **结论：** 迁移前先把当前 v0.4.0 用 changeset 流程发出去（写一个临时 changeset "bump all to 0.4.0"），再切换到 changesets 模式。
- **理由：** 不留中间态——避免"老逻辑发 0.4.0、新逻辑发 0.5.0"的混乱。

## 五、接口 / 代码骨架

### `.changeset/config.json`

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [["@flowot/nx-pn*", "nx-pn"]],
  "access": "public",
  "baseBranch": "master",
  "updateInternalDependencies": "patch"
}
```

### `.changeset/README.md`（给贡献者）

```md
# Changesets

每次涉及版本变更的 PR 必须附带一个 changeset 文件。

## 怎么加

\`\`\`
pnpm changeset
\`\`\`

按提示选择：哪些包 / bump 类型 / 摘要。

## 何时不加

PR title 含以下前缀时不加 changeset：
- `chore:`、`docs:`、`test:`、`ci:`、`build:`

## linked 规则

`.changeset/config.json` 的 `fixed: [["@flowot/nx-pn*", "nx-pn"]]` 表示
family 内所有包保持同一版本号；升级 host 会自动 bump 其他 family 包。
```

### `.github/workflows/changesets-pr-check.yml`

```yaml
name: Changesets PR check
on:
  pull_request:
    branches: [master]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - name: Check changeset present (when needed)
        run: |
          # 如果 PR title 是 chore/docs/test/ci/build 则跳过
          if echo "${{ github.event.pull_request.title }}" | grep -Eq "^(chore|docs|test|ci|build):"; then
            echo "skip — changeset not required"
            exit 0
          fi
          if [ -z "$(ls .changeset/*.md 2>/dev/null | grep -v README.md | grep -v config.json)" ]; then
            echo "::error::missing changeset — run 'pnpm changeset' to add one"
            exit 1
          fi
      - name: Validate changeset format
        run: pnpm changeset status --since=master
```

### 改造后的 `.github/workflows/npm-publish.yml`（发布步骤）

```yaml
- name: Version packages
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    pnpm changeset version
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    if [ -n "$(git status --porcelain)" ]; then
      git add .
      git commit -m "Version Packages"
    fi

- name: Publish packages
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    pnpm changeset publish
    git push --follow-tags
```

## 六、职责边界

- 本方案解决：(a) 声明式变更管理；(b) 自动 CHANGELOG；(c) PR 阶段拦截；(d) 依赖联动。
- 不解决：(e) 发布中间失败的续跑——仍依赖方案 B 的 state file。
- 不解决：(f) 漏发被提前发现——仍依赖方案 A 的 preflight。
- 本方案是"长期演进"层；如果实施，建议与方案 A + B 同时落地，否则 changeset 的"自动 publish"会再次被现有 CI 的脆弱性拖垮。

## 七、改动范围（影响面）

| 模块 | 现状 | 改后 | 影响 |
|---|---|---|---|
| `.changeset/` | 不存在 | 新目录（config + README + 每次 PR 一个 md） | 开发者工作流变化 |
| `.github/workflows/npm-publish.yml` | 读 `apps/cli/package.json` + 硬编码 publish | 改用 `pnpm changeset version` + `pnpm changeset publish` | workflow 体积 -50 行 |
| `.github/workflows/changesets-pr-check.yml` | 不存在 | 新增 PR check | PR 阶段多 1 个必须 pass 的 job |
| `package.json` (root) | 无 changeset scripts | 加 `"changeset": "changeset"` | 维护者本地命令多一个 |
| 团队习惯 | 修代码 + push 等 CI 自动发版 | 修代码 + `pnpm changeset` + push | **需要写迁移指南 + 团队培训** |

## 八、迁移 / 实施路径

1. **Step 1**：先用当前流程把 v0.4.0 发出去（避免中间态）。
2. **Step 2**：加 `@changesets/cli` 依赖；初始化 `.changeset/config.json`。
3. **Step 3**：加 PR check workflow；先设为"warn"不 fail，观察 1~2 个 PR。
4. **Step 4**：把 PR check 升为 fail。
5. **Step 5**：改造 npm-publish.yml 为 changeset 驱动；第一次 changeset version + publish 跑通后保留。
6. **Step 6**：删除/简化当前 `tools/list-publishable.mjs`、`tools/preflight-publish.mjs`、`tools/publish-state.mjs`（看是否还需要；changesets 自带 publish 编排）。

迁移期约 2~3 周（含 PR check warn 期）。

## 九、验收标准

| # | 验证项 | 方法 |
|---|---|---|
| 1 | PR 缺 changeset 时 CI fail | 提一个故意不加 changeset 的 PR，CI 报红 |
| 2 | `pnpm changeset version` 后所有 family 包版本一致 | 检查 git diff，确认 host + core + cli 等版本同步 bump |
| 3 | CHANGELOG.md 自动生成 | 比对发布前后 CHANGELOG 内容 |
| 4 | `pnpm changeset publish` 一次性发完所有变更包 | CI 跑完，npm registry 看到所有 family 包同时出现新版本 |
| 5 | 依赖联动生效 | host minor → core/client/cli patch 自动 bump |

## 十、待用户拍板的决策

| # | 决策 | 推荐 |
|---|---|---|
| 1 | `nx release` 还是 `@changesets/cli` | `@changesets/cli`（推荐）—— nx release 19.x API 不稳定 |
| 2 | linked 还是 independent 模式 | linked（推荐）—— 维持 family 同版本约定 |
| 3 | 是否废弃方案 A 的 preflight | 不废弃（推荐）—— changesets publish 内部仍可能漏发；preflight 仍是兜底 |
| 4 | 是否废弃方案 B 的 state file | 不废弃（推荐）—— changeset publish 失败仍需 state 重发 |

## 十一、参考

- 现状文档：`project/2026-09-08-v1-status.md`（第 2、6 节）
- 配套 design：方案 A（preflight）、方案 B（state file）、方案 D（独立版本，未在此次讨论）
- 工具：`@changesets/cli` 文档、`nx release` 文档
- 类似实践：Vue.js、NestJS、pnpm 自身都用 changesets 管理 monorepo 版本