Intent: CLI 扩展 — 插件管理 / audit 查询 / 插件构建 (自动化入口)

> **Date:** 2026-09-04
> **Topic:** cli-automation
> **类型:** intent doc(预测设计)
> **版本:** v1（首版）
> **状态:** 试验
> **核心问题:** 把 nx-pn 的 CLI 从"只能启动 server"扩展成插件开发者可用的自动化入口：插件管理命令族 + audit 请求流水查询（过滤/排序/limit/status）+ 插件构建命令

## 原始请求（用户原话）

> "现在cli是只能够启动server吗 对于三个基本业务设计 有没有cli方式支持直接获得 对应格式,方便完成自动化 比如通过cli 导出最近的一些审计记录 以及通过cli添加插件 ..."
> "开始扩展cli的能力 插件管理 api请求流水(支持过滤,排序,limit,返回状态码等查询条件 构建) 构建完成的cli操作的能力,然后把这个总结为ref的插件开发者人群 , 插件开发者可以通过这个cli,结合agent完成一些自动化流程"

## 轻微重写版（仅修错别字与口癖）

> "现在 CLI 是只能启动 server 吗？对于三个基本业务设计，有没有 CLI 方式支持直接获得对应格式，方便完成自动化？比如通过 CLI 导出最近的一些审计记录，以及通过 CLI 添加插件……"
> "开始扩展 CLI 的能力：插件管理、API 请求流水（支持过滤、排序、limit、返回状态码等查询条件）、插件构建。把构建完成的 CLI 操作能力总结为给插件开发者人群的 ref——插件开发者可以通过这个 CLI 结合 agent 完成一些自动化流程。"

## 本版要验证的假设

1. CLI 扩展为**一次性子命令族**（audit/plugin/build），复用现有 add/uninstall 的"临时启 host + 脱机读/写 storage domain"与"host 在跑时走 REST"双模式——不需要 daemon。
2. audit 查询的过滤/排序/limit/status 查询条件，在 **host 的 audit-route REST + CLI 脱机读**双侧同构实现（REST 支持 live host，CLI 冷启动读 auditDomain）。
3. 插件构建命令能复用现有 build-zip.mjs（esbuild 打包 host.js/browser.js + zip），CLI 只做包装；build + add 能连成一条自动化链路。

## 一、设计原则

| # | 原则 | 体现 |
| - | --- | --- |
| 1 | CLI 是**短命客户端**，不是 daemon | 一次子命令 → 探活 host → 有则 REST / 无则临时启 host + 操作 storage domain → 退出。所有读命令走同构的"读 storage domain"实现 |
| 2 | 查询面**双侧同构** | host audit-route + CLI audit 子命令用同一套查询谓词（method/status/url/initiator/sinceId/limit/order）。避免 REST 一套、domain 一套导致行为漂移 |
| 3 | 输出**格式可选**（默认 human，可 `--format json`/`jsonl`/`csv`） | 机器可读是自动化的前提；human 默认照顾交互 |
| 4 | 插件**管理命令族对齐已有 REST** | `plugin list` / `plugin show <id>` / `plugin stop` / `plugin remove` / `plugin uninstall` 与 `/api/plugins` 的 REST 端点语义一一对应（复用 probe/forward 模式） |
| 5 | build **复用现有 build-zip.mjs**，CLI 只包装 | 不重造 esbuild 逻辑；`build <dir>` 调该目录的 build 脚本产出 dist/*.zip |
| 6 | **安全**：`cred` 相关（写 secret）推迟；secret 不进 argv | shell history/ps 是明文。本轮只读（`cred list` 输出 hash 不输出 secret）或整体推迟 |

## 二、模块拆分

```
apps/cli/src/
├── main.ts                     改  parseArgs 支持 5 个新子命令；runCli 分发
├── commands/
│   ├── audit-list.ts           新  audit list [--since-id N] [--limit N] [--method M] [--status S]
│   │                                [--url SUBSTR] [--initiator I] [--order asc|desc] [--format json|jsonl|csv]
│   ├── audit-lastid.ts         新  audit lastId  (输出单一数字, CI 友好)
│   ├── plugin-list.ts          新  plugin list [--format json|table]
│   ├── plugin-show.ts          新  plugin show <id|runId>  (单条 manifest JSON)
│   ├── plugin-stop.ts          新  plugin stop <runId>
│   ├── plugin-remove.ts        新  plugin remove <runId>  (= stop + lifecycle eviction)
│   ├── plugin-uninstall.ts     新  plugin uninstall <runId|id>  (= remove + npm ledger drop)
│   └── build.ts                新  build <pluginDir>  (跑 scripts/build-zip.mjs)
└── main.test.ts                改/增  每个新子命令的 parseArgs + 冒烟测试

packages/host/src/server/
├── audit-route.ts              改  支持 method/status/url/initiator/limit/order 查询谓词
├── http-utils.ts               改  增 parseFilters 辅助（若适用）
packages/host/src/__tests__/audit-route.test.ts  改  覆盖新查询谓词
```

## 三、数据流（关键场景）

### 3.1 `audit list` — 导出最近的审计记录

```
npx @flowot/nx-pn audit list --limit 50 --format jsonl
  ├── probeHost(:4560)
  │     ├── 活 → GET /api/audit?limit=50&order=desc
  │     │        → 解析 { ok, data: { lastId, records } }
  │     │        → --format jsonl: 逐行打印 JSON
  │     └── 死 → 临时 startHost({port:0, dataDir}) → auditDomain.table('records').entries()
  │              → 按 sinceId/limit/method/status/url/initiator 谓词过滤 → 排序 → 逐行打印
  │              → host.stop()
  └── 退出码 0（有记录）/ 非 0（错误）
```

### 3.2 `build <dir> && add <file:dir/dist/xxx.zip>` — 构建 + 上传插件一条链

```
npx @flowot/nx-pn build ./my-plugin        # → ./my-plugin/dist/my-plugin.zip
npx @flowot/nx-pn add file:./my-plugin/dist/my-plugin.zip
  └── probeHost(:4560)
        ├── 活 → POST /api/plugins (multipart zip upload) → hot-add
        └── 死 → 临时 startHost → loader.load(zipBytes) → ledger
```

### 3.3 `plugin list` / `plugin show` — 管理已装插件

```
npx @flowot/nx-pn plugin list --format json
  ├── probeHost(:4560) → 活: GET /api/plugins → list
  └── 死 → 临时 startHost → lifecycle.list() → id/pluginRunId/manifest 映射
  └── --format table → 对齐打印 id | pluginRunId | title | version
```

## 四、关键决策（含选型说明）

| # | 决策 | 结论 | 理由 | 备选 |
| - | --- | --- | --- | --- |
| D1 | audit 查询谓词放 host REST + CLI 双侧 | 双侧同构 | host 在跑时 CLI 走 REST（语义一致）；冷启动读 domain。避免两侧行为漂移 | 只在 CLI 读 domain（host 在跑时也绕 REST——不一致，且 host 侧新增的 limit/order 谓词 CLI 用不上） |
| D2 | `--order asc\|desc` 默认 desc | desc（最新在前） | 用户要"最近审计记录"，desc 是默认心智 | asc（旧版 web 页就是 asc，但 CLI 默认取新） |
| D3 | 输出默认 human、`--format json\|jsonl\|csv` 可选 | 默认 human | 交互友好；`--format` 显式切机器可读 | 默认 json（全机器但交互难看） |
| D4 | `plugin stop/remove/uninstall` 走 probe+REST | 复用 forward 模式 | CLI 已有 add/uninstall 的 probe 模式，扩展 stop/remove 只需 forward 到对应 POST 端点 | 全部临时启 host（对运行中的 host 无效——stop/remove 操作的是 lifecycle 里 live fiber，必须走 live host） |
| D5 | `cred` 相关推迟 | 本轮不做 cred set/get | secret 入 argv 是安全 footgun；`resolve` 从 auditDomain 读，但 CLI 没有非交互 secret 输入通道 | prompt() + --from-stdin（工作量大，单独一轮） |
| D6 | `plugin list` 需要 zipPath? | 暴露 id/pluginRunId/manifest.title/version | 自动化要的清单面 | 全 manifest（信息多但噪音） |
| D7 | build 复用 build-zip.mjs | CLI `build <dir>` 调该目录 build 脚本 | 不重造 esbuild 逻辑；各插件目录已是 build 脚本 | CLI 内嵌 esbuild（重复，且各插件构建参数可能不同） |

## 五、接口 / 代码骨架

```ts
// audit-list 谓词（与 host audit-route 同构）
export interface AuditQuery {
  sinceId?: number
  limit?: number
  method?: string          // GET|POST|PUT|PATCH|DELETE
  status?: number          // exact match, or code class? v1: exact
  url?: string             // substring
  initiator?: string       // substring (core/replay:<id>/<pluginId>)
  order?: 'asc' | 'desc'   // default 'desc'
}
export type AuditFormat = 'human' | 'json' | 'jsonl' | 'csv'

// main.ts: parseArgs 加子命令分支
export type CliSubcommand =
  | 'add' | 'uninstall' | 'init'
  | 'audit'              // audit list|lastId
  | 'plugin'             // plugin list|show|stop|remove|uninstall
  | 'build'              // build <dir>
export interface CliOptions {
  // ...
  auditAction?: 'list' | 'lastId'
  auditQuery?: AuditQuery
  pluginAction?: 'list' | 'show' | 'stop' | 'remove' | 'uninstall'
  target?: string         // plugin id/runId/dir
}

// host audit-route.ts: 加 limit/order/method/status/url/initiator 谓词
// GET /api/audit?method=GET&status=200&url=api&initiator=replay&limit=50&order=desc
```

## 六、职责边界

| 关注点 | 归属 |
| --- | --- |
| audit 查询谓词执行 | host audit-route（live） + CLI audit 命令（冷启动 domain 同构实现） |
| 插件管理（stop/remove/uninstall 操作 live fiber） | **必须走 live host REST**（fiber 只在 live host lifecycle 里）——CLI 不能冷启动去操作别人的 fiber |
| 插件 build | 各插件目录的 build-zip.mjs；CLI 只调不实现 |
| secret 安全 | cred 命令推迟；未来 prompt()/stdin |
| 输出格式 | CLI 层（host REST 永远 JSON；CLI --format 负责转 human/jsonl/csv） |

## 七、改动范围（影响面）

| 模块 | 现状 | 改后 | 影响 |
| --- | --- | --- | --- |
| apps/cli/src/main.ts | 3 子命令(add/uninstall/init) | +5 子命令族 | parseArgs/runCli 扩展 |
| apps/cli/src/commands/*（新） | 无 | 8 文件 | 纯新增 |
| apps/cli/src/main.test.ts | parseArgs 测试 | +新子命令 parse 测试 | 测试增 |
| packages/host/src/server/audit-route.ts | sinceId/lastId only | +method/status/url/initiator/limit/order | 查询面扩 |
| packages/host/src/__tests__/audit-route.test.ts | 现有 | +新谓词测试 | 测试增 |
| .claude/skills/api-audit/references/plugin-developer/cli-automation.md | 无 | 新 ref | 文档增 |

## 八、迁移 / 实施路径

1. **P1 audit 查询谓词（host 侧）**：audit-route 支持 limit/order/method/status/url/initiator → 测试
2. **P2 CLI audit 命令族**：audit list/lastId + --format → 测试（含冷启动脱机读 domain 路径）
3. **P3 CLI plugin 命令族**：list/show/stop/remove/uninstall（probe+REST）→ 测试
4. **P4 CLI build**：build <dir> 包装 build-zip.mjs → 测试
5. **P5 文档**：写 plugin-developer/cli-automation.md ref（含 agent 自动化用例）

## 九、验收标准

| # | 验证项 | 方法 |
| - | ------ | ---- |
| 1 | audit list 过滤/排序/limit 生效 | 启 host → 造几条 GET/POST + 不同 status → `audit list --method GET --status 200 --limit 5 --order desc --format json` → 断言过滤/排序/limit |
| 2 | audit list 冷启动（host 未跑）读 domain | host 停 → `audit list --format jsonl` → 读到上次持久化的记录 |
| 3 | plugin list / show 在 host 跑时走 REST | 启 host 装 echo → `plugin list --format json` 列出 → `plugin show echo` 出 manifest |
| 4 | plugin stop/remove/uninstall 操作 live host | 启 host 装 echo → `plugin stop run-N` → lifecycle 里 fiber 停 |
| 5 | build 产出 zip | `build ./plugins/echo` → dist/echo.zip 存在且 loader 能吃 |
| 6 | 文档：cli-automation.md 存在 + 含 agent 自动化示例 | grep 断言 |

## 十、待用户拍板的决策

| # | 决策 | 推荐 |
| - | ---- | ---- |
| 1 | `--format` 默认值 | human（交互）；`--format json` 显式切自动化 |
| 2 | cred 命令本轮做不做 | 推迟（secret 进 argv 是安全 footgun）——除非用户要，单独一轮加 prompt() |
| 3 | audit 查询默认 order | desc（最新在前） |

## 十一、audit 记录不脱敏（产品决策，偏离 spec §4.2）

**决定**：审计中间件 **不做 credential redaction**。Authorization / x-api-key / cookie 等头的值**原样进入审计记录**，且**原样发送给后端**。

**理由**（用户明确）：
1. 这是个人本地审计工具（data-dir 用户自持），调试时要看真实的请求头/响应头——hash 化后无从还原，无法诊断认证类问题。
2. spec 原设计 `redactCredentials` 会同时改写 `ctx.headers`（即真实发出的请求），导致后端收到的是脱敏占位符而非真实凭证——这是 bug，不是特性。
3. `audit list --format jsonl/csv` 导出的就是开发/agent 调试要用的原始凭证流。

**实现**（commit 待定）：
- `audit-middleware.ts` 移除 `redactCredentials` 调用；改在入口做 **header key 小写归一**（值原样保留），保证 record reqHeaders 与 wire 大小写一致。
- `packages/core/src/credentials.ts` 的 `redactCredentials` / `SENSITIVE_HEADER_NAMES` **保留**（导出的库能力，供显式调用），但 docstring 注明"audit middleware 不调用"。
- spec §4.2 的"凭证脱敏"是**历史假设**，spec 文档不改（作为历史快照）；本 decision 是偏离记录。

## 十二、参考

- 现状：`apps/cli/src/main.ts`（3 子命令 + probe/forward 模式）、`packages/host/src/server/audit-route.ts`（sinceId/lastId only）、`packages/host/src/server/plugin-route.ts`（REST 端点全）
- 相关 ref：`.claude/skills/api-audit/references/core-developer/operations.md`、`plugin-developer/scaffolding.md`
- CLI 现有模式：`runAdd`/`runUninstall` 的"探活 → forward REST / 临时 host + storage domain"
