# Design: 发布完整性保证（publish-completeness-guarantee）

> **Date:** 2026-09-08
> **Topic:** multi-package-release
> **类型:** intent doc（预测设计）
> **版本:** v1（相对：新建）
> **状态:** 候选
> **核心问题:** 如何保证 `@flowot/nx-pn*` 家族所有包都完整发布到 registry，避免"npm 报成功但实际没落库"或"publish 中途失败导致部分遗漏"？

## 原始请求（用户原话）

> 如何保证所有的 package 都完整发布 避免出现遗漏 就比如我之前 nx-pn 的一些包没有发布 导致报错

## 轻微重写版（仅修错别字与口癖）

> 如何保证所有的 package 都完整发布，避免出现遗漏？就比如我之前 nx-pn 的一些包没有发布，导致报错。

## 版要验证的假设

如果在 publish 循环中加入"**publish → 回查 registry integrity → 失败重试 → 末尾完整性审计**"闭环，那么：
- (H1) "npm 报成功但 registry 没落库"（0.4.0 web 那种）能在 publish 步骤内被立即发现并重试，不会留到用户 `npm install` 时才暴露。
- (H2) publish 中途失败（E409/E429/网络）能通过指数退避重试自动恢复，而不是 `set -e` 直接终止、留下半残 release。
- (H3) 即使重试后仍缺漏，末尾的完整性审计会 fail 整个 job 并打印缺漏清单，让人工用 `npm-fix-publish.yml` 精准补发，而不是靠用户报错才发现。

## 一、设计原则

| # | 原则 | 体现 |
|---|---|---|
| 1 | **不信任 npm 的"成功"输出** | publish 后必须回查 registry，比对 `dist.integrity` 与本地 tarball sha512 |
| 2 | **失败可重入** | 重试用指数退避（≥2s 间隔），重试前重读 registry（防"报了失败但实际落库"） |
| 3 | **末尾兜底审计** | 所有包 publish 完成后，遍历清单逐个确认 registry 状态 + integrity；任何一个缺/不匹配即 fail |
| 4 | **幂等** | 同 integrity 的包 skip（重跑安全）；不同 integrity 同版本 fail（内容变了没 bump） |
| 5 | **与现有机制协同** | 复用 `tools/preflight-publish.mjs`（auto-discover + 闭包预检）和 `npm-fix-publish.yml`（补发） |

## 二、模块拆分

新增/修改文件：

```
tools/publish-integrity.mjs          # 新增：单包 publish + 回查 + 重试
tools/audit-release.mjs              # 新增：末尾完整性审计
.github/workflows/npm-publish.yml    # 修改：publish 循环改为调用 publish-integrity，末尾加 audit
```

职责：

- `publish-integrity.mjs <tarball> <name> <version>`：
  1. 计算本地 tarball sha512
  2. `npm publish <tarball> --provenance --access public`
  3. publish 成功后（或报失败后）**立即回查** `npm view <name>@<version> dist.integrity --json`
  4. 比对：一致 → done；不一致/缺 → 重试（最多 4 次，间隔 2s × 2^n）
  5. 重试前**重读 registry**（防"报了失败但实际落库"）
  6. 超过重试次数仍缺/不匹配 → exit 1 + 打印缺漏信息

- `audit-release.mjs <manifest.json>`：
  1. 读取 manifest（本次 publish 的包列表 + 版本 + 预期 integrity）
  2. 逐个 `npm view <name>@<version> dist.integrity --json`
  3. 缺 → 加入 missing；不匹配 → 加入 corrupted
  4. missing/corrupted 非空 → exit 1 + 打印清单（供 fix-publish 用）

- `npm-publish.yml`：
  - publish 循环改为：pack → `node tools/publish-integrity.mjs <tb> <name> <version>` → 记录结果到 manifest
  - 循环结束后：`node tools/audit-release.mjs .release/manifest.json`

## 三、数据流（关键场景）

### 场景 1：正常全量发布

```
for each pkg:
  pack → publish-integrity.mjs
    → npm publish → 回查 registry → integrity 一致 → done
  → 写入 manifest.published[]
audit-release.mjs
  → 逐个确认 registry → 全部 pass → job success
```

### 场景 2：publish 报失败但实际落库（0.4.0 web 那种）

```
publish-integrity.mjs:
  → npm publish → 报 error（但 registry 实际已落库）
  → 回查 registry → integrity 一致 → 记 "landed despite reported failure" → done
```

### 场景 3：publish 失败 + 重试恢复

```
publish-integrity.mjs:
  → npm publish → E409（registry 写竞争）
  → 回查 registry → 缺 → 等 2s → 重试
  → npm publish → 回查 → integrity 一致 → done
```

### 场景 4：重试耗尽仍缺 → 末尾审计兜底

```
publish-integrity.mjs:
  → 4 次重试后仍缺 → exit 1（但继续处理其他包，不中断循环）
  → 写入 manifest.failed[]
audit-release.mjs:
  → 发现 missing → exit 1 + 打印 "missing: @flowot/nx-pn-web@0.4.0"
  → job fail → 人工用 npm-fix-publish.yml 补发
```

### 场景 5：内容变了没 bump（integrity 不匹配）

```
audit-release.mjs:
  → registry 有该版本，但 integrity ≠ 本地 tarball
  → 加入 corrupted → exit 1 + 打印 "content changed without version bump"
  → 必须 bump 重发（防静默覆盖）
```

## 四、关键决策

### D1：回查用 `dist.integrity` 还是 `version`

- **结论：** 用 `npm view <name>@<version> dist.integrity --json`（sha512）
- **理由：** `version` 存在性判定（当前方案）检测不到"版本同但字节不同"的静默漂移；integrity 是内容指纹。0.4.0 web 那种"npm 报成功但 registry 没落库"在 integrity 比对下会立即暴露（缺 → missing）。
- **备选：** 只查 `version`。被否决：跟当前方案一样有盲区。

### D2：重试策略

- **结论：** 最多 4 次，间隔 2s × 2^n（2s, 4s, 8s, 16s），重试前重读 registry
- **理由：** 跟 dsh 的 publish.ts 一致（已验证）；registry 写竞争（E409）通常在 2s 内消化
- **备选：** 固定间隔 1s 重试 3 次。被否决：E409 在连续快速写时更容易触发

### D3：publish 失败时是否中断循环

- **结论：** **不中断**——继续处理其他包，失败的记入 `manifest.failed[]`，末尾由 audit 统一 fail
- **理由：** 一次失败就中断会让后续包全部漏发（当前 `set -e` 的缺陷）；收集所有失败一次性报告更利于人工补发
- **备选：** 任一失败立即中断。被否决：会放大漏发范围

### D4：audit 失败后的修复路径

- **结论：** 打印缺漏清单（`@flowot/nx-pn-web@0.4.0` 形式）→ 人工用 `npm-fix-publish.yml` 补发
- **理由：** fix-publish 已支持按目录补发；audit 输出直接可作为 fix-publish 的 `dirs` 输入
- **备选：** audit 失败自动触发 fix-publish。被否决：自动重试可能放大问题（如内容损坏时反复发同一坏包）

### D5：manifest 格式

- **结论：** `.release/manifest.json`，结构：
  ```json
  {
    "version": "0.4.1",
    "published": [{"name": "@flowot/nx-pn-storage", "version": "0.4.1", "integrity": "sha512-...", "tarball": "..."}],
    "failed": [{"name": "@flowot/nx-pn-web", "version": "0.4.1", "reason": "..."}]
  }
  ```
- **理由：** 给 audit 和 fix-publish 提供机器可读的上下文

## 五、接口 / 代码骨架

### `tools/publish-integrity.mjs`

```js
#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const TRANSIENT_CODES = ['E409', 'E429', 'E500', 'E502', 'E503', 'E504', 'ETIMEDOUT', 'ECONNRESET']
const MAX_ATTEMPTS = 4
const BASE_INTERVAL_MS = 2000

const [tarball, name, version] = process.argv.slice(2)
const localIntegrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`

function registryIntegrity() {
  try {
    const out = execSync(`npm view "${name}@${version}" dist.integrity --json`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const parsed = JSON.parse(out)
    return typeof parsed === 'string' && parsed ? parsed : null
  } catch (e) {
    const output = `${e.stdout || ''}${e.stderr || ''}`
    if (output.includes('E409') || output.includes('404')) return null
    throw e
  }
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  // publish
  try {
    execSync(`npm publish "${tarball}" --provenance --access public`, { stdio: 'inherit' })
  } catch (e) {
    const output = `${e.stdout || ''}${e.stderr || ''}`
    // 报失败但可能已落库——回查
    const settled = registryIntegrity()
    if (settled === localIntegrity) {
      console.log(`publish-integrity: ${name}@${version} landed despite reported failure, continuing`)
      process.exit(0)
    }
    if (attempt === MAX_ATTEMPTS || !TRANSIENT_CODES.some(c => output.includes(`code ${c}`))) {
      console.error(`publish-integrity: ${name}@${version} failed after ${attempt} attempts`)
      process.exit(1)
    }
    const backoff = BASE_INTERVAL_MS * 2 ** (attempt - 1)
    console.log(`publish-integrity: ${name}@${version} transient failure, retry in ${backoff}ms`)
    await sleep(backoff)
    continue
  }

  // publish 报成功——回查确认
  const settled = registryIntegrity()
  if (settled === localIntegrity) {
    console.log(`publish-integrity: ${name}@${version} verified on registry`)
    process.exit(0)
  }
  if (settled === null) {
    // 缺——重试
    if (attempt === MAX_ATTEMPTS) {
      console.error(`publish-integrity: ${name}@${version} missing on registry after ${attempt} attempts`)
      process.exit(1)
    }
    const backoff = BASE_INTERVAL_MS * 2 ** (attempt - 1)
    console.log(`publish-integrity: ${name}@${version} not on registry yet, retry in ${backoff}ms`)
    await sleep(backoff)
    continue
  }
  // integrity 不匹配——内容变了没 bump
  console.error(`publish-integrity: ${name}@${version} integrity mismatch\n  local:     ${localIntegrity}\n  registry:  ${settled}`)
  process.exit(1)
}
```

### `tools/audit-release.mjs`

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const missing = []
const corrupted = []

for (const pkg of manifest.published) {
  try {
    const out = execSync(`npm view "${pkg.name}@${pkg.version}" dist.integrity --json`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const registryIntegrity = JSON.parse(out)
    if (registryIntegrity !== pkg.integrity) {
      corrupted.push({ ...pkg, registryIntegrity })
    }
  } catch (e) {
    missing.push(pkg)
  }
}

if (missing.length === 0 && corrupted.length === 0) {
  console.log(`audit-release: all ${manifest.published.length} packages verified on registry`)
  process.exit(0)
}

console.error('audit-release: FAILED')
if (missing.length) {
  console.error('missing from registry:')
  for (const p of missing) console.error(`  - ${p.name}@${p.version}`)
}
if (corrupted.length) {
  console.error('integrity mismatch (content changed without version bump):')
  for (const p of corrupted) console.error(`  - ${p.name}@${p.version}`)
}
process.exit(1)
```

### workflow 改造片段

```yaml
- name: Publish to npm (with integrity verification)
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: |
    set -euo pipefail
    mkdir -p .release
    echo '{"version":"'$VERSION'","published":[],"failed":[]}' > .release/manifest.json
    for d in \
      packages/storage/storage \
      packages/storage/storage-json \
      packages/storage/storage-sqlite \
      packages/storage/storage-domain \
      packages/core \
      packages/client \
      apps/web \
      packages/host \
      apps/cli \
      apps/nx-pn; do
      name=$(node -p "require('./$d/package.json').name")
      version=$(node -p "require('./$d/package.json').version")
      if npm view "$name@$version" version >/dev/null 2>&1; then
        echo "• $name@$version already published — skipping"
        continue
      fi
      echo "• packing $name@$version"
      tb=$( (cd "$d" && pnpm pack --pack-destination ../../.release) | tail -n 1 )
      echo "• publishing $name@$version with integrity verification"
      if node tools/publish-integrity.mjs "$tb" "$name" "$version"; then
        integrity=$(node -p "require('node:crypto').createHash('sha512').update(require('node:fs').readFileSync('$tb')).digest('base64')")
        node -e "
          const m = require('./.release/manifest.json');
          m.published.push({name:'$name',version:'$version',integrity:'sha512-$integrity',tarball:'$tb'});
          require('node:fs').writeFileSync('./.release/manifest.json', JSON.stringify(m, null, 2));
        "
      else
        node -e "
          const m = require('./.release/manifest.json');
          m.failed.push({name:'$name',version:'$version',reason:'publish-integrity failed'});
          require('node:fs').writeFileSync('./.release/manifest.json', JSON.stringify(m, null, 2));
        "
      fi
    done
    echo "release publish complete"

- name: Audit release completeness
  run: node tools/audit-release.mjs .release/manifest.json
```

## 六、职责边界

- 本方案解决：**发布完整性**——所有包都落库、字节正确、失败可重试可审计。
- 不解决：**依赖闭包预检**（已由 `tools/preflight-publish.mjs` 覆盖）。
- 不解决：**补发机制**（已由 `npm-fix-publish.yml` 覆盖；本方案只提供缺漏清单作为其输入）。
- 本方案与 dsh 的 `publish.ts` 模型高度同构（三态 integrity 比对 + 指数退避重试 + 重试前重读 registry），但适配 nx-pn 的 shell-based workflow。

## 七、改动范围（影响面）

| 模块 | 现状 | 改后 | 影响 |
|---|---|---|---|
| `tools/publish-integrity.mjs` | 不存在 | 新文件，~80 行 | 单包 publish + 回查 + 重试 |
| `tools/audit-release.mjs` | 不存在 | 新文件，~50 行 | 末尾完整性审计 |
| `.github/workflows/npm-publish.yml` | fire-and-forget 循环 | 调用 publish-integrity + 末尾 audit | 体积 +~30 行，语义从"发完即忘"改为"发完确认" |

## 八、迁移 / 实施路径

1. **Step 1**：写 `tools/publish-integrity.mjs` + `tools/audit-release.mjs`，本地 dry-run（用已发布的 0.4.1 包做回查测试）。
2. **Step 2**：改造 `npm-publish.yml` 的 publish 循环。
3. **Step 3**：观察下一次 push-to-master 的 CI 行为——特别关注：
   - publish-integrity 是否正确识别"已发布"（skip）
   - audit 是否全 pass
   - 故意制造一次失败（如断网模拟）看重试是否生效
4. **Step 4**：如果 audit 失败，用 `npm-fix-publish.yml` 补发，验证修复闭环。

## 九、验收标准

| # | 验证项 | 方法 |
|---|---|---|
| 1 | 正常全量发布时，audit 全 pass | push to master，CI 日志显示 "all N packages verified" |
| 2 | 模拟"npm 报失败但实际落库"，publish-integrity 识别为成功 | 构造一个 publish 报 error 但 registry 已落库的场景（或 mock），验证 "landed despite reported failure" 路径 |
| 3 | 模拟 publish 失败（E409），重试后成功 | 构造 registry 写竞争，验证指数退避重试 |
| 4 | 模拟 publish 失败且重试耗尽，audit 兜底 fail 并打印缺漏 | 构造持续失败，验证 audit 输出 missing 清单 |
| 5 | 模拟"版本同但字节不同"，audit 报 corrupted | 构造 integrity 不匹配，验证 "content changed without version bump" 拦截 |
| 6 | 重跑同版本（同 artifact），全部 skip | 同 commit 重跑 CI，验证幂等 |

## 十、待用户拍板的决策

| # | 决策 | 推荐 |
|---|---|---|
| 1 | 是否现在实施（进 0.4.2）还是先观察 | 推荐进 0.4.2——0.4.0 的 web 漏发已证明当前 fire-and-forget 有盲区 |
| 2 | 重试次数（当前推荐 4 次） | 4 次（跟 dsh 一致） |
| 3 | 是否把 publish 循环从 shell 改成 node 脚本（更易维护） | 暂不推荐——保持 shell，降低改动风险；后续可重构 |
| 4 | audit 失败是否自动触发 fix-publish | 不自动（推荐）——人工确认后再补发，防坏包反复发 |

## 十一、参考

- 现状文档：`../project/2026-09-08-v1-status.md`（第 5 节 CI 缺陷）
- 外部参考：`../project/compare_dsh-release-sequences-2026-09-08-v1-status.md`（dsh 的 publish.ts 三态 integrity 模型）
- 配套 design：`../intent/preflight-dependency-closure-2026-09-08-v1-design.md`（发布前预检）
- 配套 workflow：`.github/workflows/npm-fix-publish.yml`（补发机制）