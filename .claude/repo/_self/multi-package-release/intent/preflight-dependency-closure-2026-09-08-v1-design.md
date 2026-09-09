# Design: A — 依赖闭包预检（Preflight Dependency Closure）

> **Date:** 2026-09-08
> **Topic:** multi-package-release
> **类型:** intent doc（预测设计）
> **版本:** v1（相对：新建）
> **状态:** 候选
> **核心问题:** 在 `Publish to npm` 之前，如何验证"每个待发包的依赖在 registry 上都能找到对应版本"，让漏发问题在 CI 阶段就 fail fast 而不是从下游用户的 `npm install` 报错？

## 原始请求（用户原话）

> 当前的多包发布方案有点麻烦 非常容易出现更新不及时
>
> PS D:\code\a_go\leaning\gs-ac\web> npx nx-pn init access
> ... npm error code ETARGET ... No matching version found for @flowot/nx-pn-storage-domain@^0.3.3. ...
>
>   /intent-capture-discuss 给出一些解决方案

后续通过 AskUserQuestion 选定方案 A："依赖闭包预检（最小改动）"。

## 轻微重写版（仅修错别字与口癖）

> 当前的多包发布方案有点麻烦，非常容易出现更新不及时。
>
> （用户从外部项目跑 `npx nx-pn init access`，npm 报 ETARGET：`@flowot/nx-pn-storage-domain@^0.3.3` 在 registry 上找不到。）
>
> （多轮讨论选定方案 A：依赖闭包预检，作为今天 ship 的止血方案。）

## 本版要验证的假设

如果在 `Publish to npm` 之前插入一步"对所有 `workspace:^` 依赖做 registry 存在性预检 + 按拓扑顺序输出"待发清单"清单，那么：
- (H1) 漏发包能在 CI 阶段就被拦下，错误信息能直接告诉维护者"按这个顺序补发这 N 个包"。
- (H2) 不引入新工具/新依赖，纯 node 脚本 + workflow 步骤即可实现。
- (H3) 不影响正常的全量发布流程，只在确实有依赖缺失时 fail。

## 一、设计原则

| # | 原则 | 体现 |
|---|---|---|
| 1 | **Fail fast with actionable output** | 预检失败时打印待发清单（含 pkg@version 和拓扑序），不让维护者去 log 里翻 |
| 2 | **零外部依赖** | 纯 node 内置（`node:fs`、`node:path`、`node:https` 或调用 `npm view`），不引入新工具链 |
| 3 | **复用现有语义** | 用 `pnpm pack --json` 解析依赖（pack 阶段已经把 `workspace:^` 改成真实 semver） |
| 4 | **可独立运行** | `node tools/preflight-publish.mjs` 可在本地直接跑，不依赖 GitHub Actions |

## 二、模块拆分

新增/修改文件：

```
.github/workflows/npm-publish.yml    # 新增 "Preflight dependency closure" 步骤
tools/preflight-publish.mjs          # 新增：预检脚本（核心逻辑）
tools/list-publishable.mjs            # 新增：auto-discover 公开包（与方案 B 共享，先在此使用）
```

职责：

- `list-publishable.mjs`：返回 `{ dir, name, version, deps }[]`，过滤 `publishConfig.access === "public"`，按拓扑顺序排序。
- `preflight-publish.mjs`：调用 `list-publishable.mjs` 拿到列表 → 对每个包执行 `pnpm pack --json` 拿到解析后的依赖（`workspace:^` → 真实 semver）→ 逐个 `npm view <name>@<resolvedVersion> version` 验证 → 输出 pass/fail + 拓扑有序待发清单。
- workflow 新步骤：在 `Publish to npm` 之前执行，exit code 非 0 即 fail。

## 三、数据流（关键场景）

### 场景 1：全量发布（全部包已在 registry）

```
CI 触发
  → Preflight dependency closure
       list-publishable.mjs → 11 个公开包
       for each pkg: pnpm pack --json → 解析 deps
       for each dep: npm view <name>@<ver> version → OK
  → 输出："family closure OK, all 11 deps resolvable on npm"
  → exit 0
  → Publish to npm（原有逻辑继续）
```

### 场景 2：漏发（当前实际场景，缺 storage-domain@0.3.3）

```
CI 触发
  → Preflight dependency closure
       list-publishable.mjs → 11 个公开包
       for each pkg: pnpm pack --json → 解析 deps
       when checking @flowot/nx-pn-storage-domain@0.3.3:
         npm view "@flowot/nx-pn-storage-domain@0.3.3" version
         → ENOTFOUND 或 version not found
       collect blocked: [ {pkg: 'storage-domain', ver: '0.3.3', needed_by: [...]} ]
       topo sort the blocked packages (这里只有 1 个)
  → 输出：
       ❌ dependency closure broken
       blocked packages (in topo order, must be published first):
         1. @flowot/nx-pn-storage-domain@0.3.3
              needed by: @flowot/nx-pn-host
  → exit 1
  → workflow fail（不会进 Publish to npm 步骤）
```

### 场景 3：本地运行（开发调试）

```
$ node tools/preflight-publish.mjs
# 同 CI 输出，可独立使用，不依赖 GH Actions
```

## 四、关键决策

### D1：依赖解析用 `pnpm pack --json` 而非手解析 `package.json`

- **结论：** 用 `pnpm pack --json` 拿到 packed manifest，再读 `dependencies`。
- **理由：** pack 阶段已经把 `workspace:^` 改写成真实 semver（CI 已用），复用同一机制保证一致性；不需要重新实现 semver 解析器。
- **备选：** 手解析 `package.json` + 跑 `pnpm why`。被否决：要重新实现 semver 范围匹配。

### D2：用 `npm view` 还是直接调 registry HTTP API

- **结论：** 用 `npm view <name>@<version> version`，最直观、错误信息友好。
- **理由：** 失败时 stderr 直接给出 "No matching version found"，跟用户拿到的 ETARGET 错误一致——便于诊断。
- **备选：** 直接调 `https://registry.npmjs.org/<name>/<version>`。被否决：错误处理复杂。

### D3：超时与重试策略

- **结论：** 不加超时（依赖 `npm view` 内置），但给整体脚本设 `set -e` + 60s 命令超时。
- **理由：** registry 偶尔慢不至于让预检误判 fail；但单步卡死要能恢复。

### D4：输出格式（人类可读 + CI 可解析）

- **结论：** 失败时输出两段：人类可读（`❌ blocked packages (topo order)...`） + `::error::` GH Actions annotation（让 PR/CI UI 直接高亮）。
- **理由：** GH Actions 的 `::error file=...` annotation 会被 UI 渲染成红色标记。

## 五、接口 / 代码骨架

### `tools/list-publishable.mjs`（签名）

```js
/**
 * Auto-discover publishable packages in the workspace.
 * Walks apps/*/package.json and packages/**/package.json, filters
 * those with publishConfig.access === "public", sorts in topo order.
 *
 * @returns {Promise<Array<{dir: string, name: string, version: string, deps: string[]}>>}
 */
export async function listPublishable() { ... }
```

### `tools/preflight-publish.mjs`（核心 6 步）

```js
#!/usr/bin/env node
import { listPublishable } from './list-publishable.mjs'
import { execSync } from 'node:child_process'

const pkgs = await listPublishable()
const blocked = [] // { name, version, needed_by[] }

for (const pkg of pkgs) {
  // 1. pnpm pack --json 解析依赖
  const packedJson = execSync(
    `cd ${pkg.dir} && pnpm pack --pack-destination /tmp/preflight --json`,
    { encoding: 'utf8' }
  )
  const packed = JSON.parse(packedJson.split('\n').slice(-2)[0]) // 最后一行是 JSON
  const deps = Object.keys(packed.dependencies ?? {}).filter(d => d.startsWith('@flowot/') || d === 'nx-pn')

  // 2. 对每个内部依赖做 registry 存在性检查
  for (const dep of deps) {
    const depVer = packed.dependencies[dep]
    try {
      execSync(`npm view "${dep}@${depVer}" version`, { stdio: 'pipe' })
    } catch (e) {
      const blockedEntry = blocked.find(b => b.name === dep && b.version === depVer)
      if (blockedEntry) blockedEntry.needed_by.push(pkg.name)
      else blocked.push({ name: dep, version: depVer, needed_by: [pkg.name] })
    }
  }
}

// 3. 拓扑排序 blocked（按 storage 家族 → core → client → host → cli 序）
const topoOrder = ['@flowot/nx-pn-storage', '@flowot/nx-pn-storage-json',
  '@flowot/nx-pn-storage-sqlite', '@flowot/nx-pn-storage-domain',
  '@flowot/nx-pn-core', '@flowot/nx-pn-client', '@flowot/nx-pn-host',
  '@flowot/nx-pn-web', '@flowot/nx-pn', 'nx-pn']
blocked.sort((a, b) => topoOrder.indexOf(a.name) - topoOrder.indexOf(b.name))

// 4. 输出
if (blocked.length === 0) {
  console.log('✅ family closure OK, all deps resolvable on npm')
  process.exit(0)
}

console.error('❌ dependency closure broken')
console.error('blocked packages (in topo order, must be published first):')
blocked.forEach((b, i) => {
  console.error(`  ${i + 1}. ${b.name}@${b.version}`)
  console.error(`       needed by: ${b.needed_by.join(', ')}`)
  console.error(`::error::${b.name}@${b.version} not on registry — publish first`)
})
process.exit(1)
```

### workflow 插入位置

```yaml
- name: Preflight dependency closure
  run: node tools/preflight-publish.mjs

- name: Publish to npm (idempotent, per-package)
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: |
    # ... 原有逻辑 ...
```

## 六、职责边界

- 本方案只解决"漏发 → 提前发现 + 给出可执行清单"。
- 不解决"未来新增包自动加入发布列表"——那是方案 B 的范畴。
- 不解决"发布失败可重入"——那是方案 B 的 state file 范畴。
- 本方案是"今天 ship 止血"层；方案 B 是"长期方案"层。两者可叠加，也可独立采纳。

## 七、改动范围（影响面）

| 模块 | 现状 | 改后 | 影响 |
|---|---|---|---|
| `.github/workflows/npm-publish.yml` | 无预检步骤 | 新增 `Preflight dependency closure` 步骤（在 Publish 之前） | workflow 多 ~10s，单次 commit 仍然能 publish |
| `tools/preflight-publish.mjs` | 不存在 | 新文件，~80 行 | 维护者本地可独立运行 |
| `tools/list-publishable.mjs` | 不存在 | 新文件，~40 行（与方案 B 共享） | 为方案 B 铺垫 |

不修改任何源代码；不修改版本号；不动 release tag 流程；不动 `pnpm-workspace.yaml`。

## 八、迁移 / 实施路径

1. **Step 1（独立 ship）**：写 `tools/list-publishable.mjs` + `tools/preflight-publish.mjs`，本地 dry-run 验证能正确报出"当前 0.3.3 缺 storage-domain"。
2. **Step 2**：把 `Preflight dependency closure` 步骤插入 `.github/workflows/npm-publish.yml`，放在 `Publish to npm` 之前。
3. **Step 3**：下一次 push to master 时，CI 会 fail with 明确待发清单——手动跑 `npm publish` 把缺失的 storage-domain@0.3.3 补上（或合并 `8cfafb1` 那种补救提交）。
4. **Step 4**：补发后重跑 CI，确认 preflight pass。

可独立验收的边界：每一步 ship 后下一次 push to master 都能验证 preflight 行为；不需要等所有步骤一起做完。

## 九、验收标准

| # | 验证项 | 方法 |
|---|---|---|
| 1 | 全部包已发布时，preflight exit 0 | `node tools/preflight-publish.mjs` → `✅ family closure OK` |
| 2 | 模拟缺包时，preflight exit 1 且打印拓扑有序待发清单 | 把某个工作区包的 version bump 到一个未发布版本，运行 → 看到对应条目 + GH Actions annotation |
| 3 | workflow 集成后，漏发时整个 publish job fail | 推一个 bump-only commit 到 master，确认 GH Actions fail 在 Preflight 步骤、UI 红条提示 |
| 4 | 不引入新 npm 依赖 | `pnpm-lock.yaml` 无变化 |
| 5 | 维护者可在本地独立跑 | `node tools/preflight-publish.mjs` 在 CI 之外能跑出同样的结果 |

## 十、待用户拍板的决策

| # | 决策 | 推荐 |
|---|---|---|
| 1 | preflight 失败时，是否同时阻断 tag 创建？还是仅阻断 publish？ | 仅阻断 publish（推荐）—— 保留 tag 灵活性，让维护者补发后能直接重跑同一 tag |
| 2 | preflight 是否要进入 PR check（不仅仅是 push to master）？ | 不进入 PR check（推荐）—— 预检 registry 状态对 PR 阶段意义不大；留给 merge 后 |
| 3 | `list-publishable.mjs` 是否在本方案就引入（即使 B 暂不实施）？ | 是（推荐）—— preflight 也需要知道哪些包要检查；与方案 B 共享此工具 |

## 十一、参考

- 现状文档：`project/2026-09-08-v1-status.md`（第 2、5、8 节）
- 配套 design：方案 B `auto-discover-state-file-2026-09-08-v1-design.md`（共享 `tools/list-publishable.mjs`）
- CI 当前实现：`.github/workflows/npm-publish.yml`（line 55-69 的 `Verify uniform family version`、line 89-121 的 `Publish to npm`）