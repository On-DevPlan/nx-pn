# 存储架构对比: dsh storage 家族 vs nx-pn 点状持久化

> **Date:** 2026-09-04
> **Topic:** storage-audit-comparison
> **类型:** project 状态文档 (compare)
> **版本:** v1
> **对比对象:**
> - **A · dsh** 参考项目,`packages/storage/*` 家族 (deepseek-harness)
> - **B · nx-pn** 本项目,`packages/host|client|core` 的持久化现状
>
> 对比的是两方「存储系统如何设计」的现状快照,不评价、不设计。

## 一、总览

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 是否有独立「存储层」包 | ✓ 有,一组 `storage` 家族 4 包 | ✗ 无,持久化是零散点状,散在 host 各文件 |
| 存储抽象层级 | 3 层: hub(`storage`)+ 后端(backend) + 数据形(form) | 2 层: 内存结构(ring buffer)+ 文件落盘(dataDir) |
| 数据形 / 校验 | `storage-domain`: zod schema 校验 + `domain/changed` 事件 | `core/manifest-schema`: ajv JSON schema,仅校验 manifest |
| 消费方如何取数 | `ctx.storageDomain.open(spec)` → `domain.table().get/put` | `requireDeps().ringBuffer.snapshot()`,经 `ctx.auditStore` 门面 |
| 是否可替换后端 | ✓ hub 注册表,json/sqlite 并存,domain 按名路由 | ✗ 无后端概念,内存 buffer 是唯一"存储" |

## 二、逐维对比

### 2.1 分层模型

| 层 | dsh | nx-pn (本项目) |
| - | - | - |
| hub / 门面 | `ctx.storage` 注册中心: 后端注册 + data-form 挂载;自身零 IO | `ctx.auditStore` cordis 门面: 代理 ring buffer 的 snapshot/since/get/lastId;同样零 IO |
| 后端(backend) | 可插拔: `storage-json`(JSON 文件树), `storage-sqlite`(每记录一行, `node:sqlite`) | 无(内存 `AuditRingBuffer` 是唯一"后端", JSONL 持久化仅注释提及未接线) |
| 数据形(form) | `storage-domain`: `defineDomain({name,version,tables:zod})`, open/put/get/update, 写 durable 后 resolve + 发事件 | 无对应物; manifest 由 `core` ajv 校验,非存储数据形 |
| 领域(domain) | workspace 等领域: 各 owner 声明一次,消费方 open | 无 domain 概念; 审计记录/插件是两处平铺的数据 |

### 2.2 审计记录存储

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 记录类型 | `SessionEvent` 日志 (会话事件,非 HTTP 请求) | `AuditRecord` (HTTP 请求审计,含 req/res 头身、耗时、redact 后字段) |
| 存储单元 | append-only 事件日志,每会话一文件 | 内存 FIFO ring buffer, 容量 1000, `onPush`→WS 广播 `audit.append` |
| 持久化 | 是核心目标: JSONL/zstd per-session log | **默认不落盘**; `ring-buffer.ts:4` 注释 "callers may opt-in to JSONL persistence" 但未见接线 |
| 重放/查询 | `handle.read(offset,len)` 连续前缀; replay 由 session-projection 派生态 | `ringBuffer.since(sinceId)` / `.get(id)`; `/api/replay` 用 `.get(recordId)` 回放 |
| 重启恢复 | create/open/stat/list + flush 屏障 + torn-tail 恢复 | 内存清空即丢(进程重启后审计记录为空) |

### 2.3 插件/应用数据存储

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 插件本体 | 无「插件 zip」概念(插件即 npm 包) | zip → `dataDir/plugins/<uploadId>.zip`; 编译产物 → `dataDir/cache/compiled/<id>-<hash>.mjs` |
| npm 安装插件 | 安装到 profile dir,由 `dsh plugin --profile` 管理 | `dataDir/plugins-registry/`(npm prefix)+ `installed.json` ledger(id→{spec,name,version,installedAt}) |
| 重启扫描 | profile 由 launcher 重放 | `loader.restartFromDataDir()` 扫 `*.zip` 重放 |

### 2.4 校验与 schema

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 记录校验 | `storage-domain`: 打开时全量校验存量记录 + 每次写前校验; zod record schemas | manifest: `core` ajv 编译 JSON schema;审计记录 TS interface 仅类型层,无运行时 schema |
| 版本化 | domain 带 `version` 字段,后端版本不匹配报 `version-mismatch` | manifest `schemaVersion: 1`;审计记录无版本字段 |

### 2.5 配置/组装

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 配置方式 | profile yaml 组装: `storage`+`storage-json`+`storage-domain`+`routes`(domain→backend) | 无(内存结构 + dataDir 路径透传) |

## 三、规模对照

| 指标 | dsh | nx-pn (本项目) |
| - | - | - |
| storage 相关包数 | 4 (`storage`, `storage-domain`, `storage-json`, `storage-sqlite`) | 0(无独立包) |
| 独立数据形/后端 | domain + json + sqlite | ring buffer(内存) |
| 存储相关源码文件 | 每个包独立 src | `ring-buffer.ts`, `audit-record.ts`, `host-context.ts`(AuditStoreService 桩) |
| 持久化形式 | 文件树(JSON)/单文件 DB(SQLite)/每会话 log(JSONL) | zip + 编译 .mjs + installed.json ledger |

## 四、现象与差异

- **dsh 存储是「第一公民」**: 专门的 storage 家族,hub/后端/domain 分离,后端可替换,记录 schema 校验 + 事件发射,`storage-domain` 是唯一消费方(产品代码从不直接碰后端)。**nx-pn 没有独立存储层** —— 审计记录是内存 ring buffer(默认不落盘),持久化只覆盖插件本体(zip/编译产物)与 npm 安装 ledger,且为点状实现。
- **dsh 区分「会话事件日志」与「非会话数据」两条持久化 seam**: 前者归 session-persistence(session event log),后者归 storage domain。**nx-pn 只有一类审计记录**(HTTP 请求),且默认不持久化。
- **nx-pn 的 `AuditStoreService` 是「未接线的门面」**: `host-context.ts:122` 把它作为 ring buffer 的 snapshot/since/get/lastId 代理注册进 cordis,但它暴露的是内存读,不是持久化读;注释 `// MVP: no persistent credential store` 承认 MVP 阶段未做持久凭据存储。
- **dsh 每个可持久化单元自带版本 + 校验 + 故障语义**(`backend-not-found`, `version-mismatch`, `invalid-record`, `duplicate-backend`);nx-pn 无对应错误码,失败面靠抛 Error 字符串。
- **dsh 强调"模型与 agent loop 看不到存储"**(storage 家族不注册 tool/不注入 prompt/不写 session 事件);nx-pn 的存储是 host 内部实现细节,同样对浏览器侧透明,但缺少"刻意隐藏"这一层设计意图的表达。

## 参考 (Reference)

- dsh: `.claude/repo/deepseek-harness/packages/storage/{storage,storage-domain,storage-json,storage-sqlite}/README.md`
- nx-pn: `packages/host/src/client/ring-buffer.ts`, `packages/host/src/client/audit-record.ts`, `packages/host/src/cordis/host-context.ts`, `packages/host/src/plugins/{loader,installer}.ts`, `packages/core/src/{manifest,manifest-schema}.ts`
