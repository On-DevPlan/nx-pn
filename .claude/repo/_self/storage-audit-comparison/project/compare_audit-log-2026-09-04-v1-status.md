# 审计日志对比: dsh session 事件日志 vs nx-pn HTTP 请求审计

> **Date:** 2026-09-04
> **Topic:** storage-audit-comparison
> **类型:** project 状态文档 (compare)
> **版本:** v1
> **对比对象:**
> - **A · dsh** 参考项目,`packages/session/*` 家族 (deepseek-harness)
> - **B · nx-pn** 本项目,`packages/host/src/client/*` 的审计记录
>
> 对比的是两方「审计/日志」如何设计并持久化的现状,不评价、不设计。

## 一、总览

| 项 | dsh | nx-pn (本项目) |
| - | - | - |
| 审计对象 | 会话事件(`SessionEvent`): 整个 agent 会话的输入/输出/内部状态变化 | HTTP 请求/响应(`AuditRecord`): 经 `auditClient` 发出的每个请求 |
| 持久化形态 | append-only 事件日志(JSONL/zstd per session),持久化是一等目标 | 内存 FIFO ring buffer(容量 1000),默认不落盘 |
| 日志面 | 两个 seam: 会话日志(session-persistence)+ 非会话存储(storage domain) | 单一审计记录类型,无会话/非会话之分 |
| 服务门面 | `ctx.sessionPersistence` → `SessionHandle`(create/open/stat/list + flush) | `ctx.auditStore` → ring buffer 代理(snapshot/since/get/lastId) |
| 校验 | 存储记录 fail-closed 校验; 读连续前缀不露 torn tail | TS interface + ajv(仅 manifest),审计记录无运行时校验 |

## 二、逐维对比

### 2.1 记录的语义与内容

| 维度 | dsh `SessionEvent` | nx-pn `AuditRecord` |
| - | - | - |
| 用途 | 会话可重放/可投影;模型和 agent loop 通过它恢复上下文 | 审计工作台: 展示请求详情 + 一键重放(credential-redacted) |
| 结构 | 会话事件(每类 event 自己的 shape),metadata 走 `SessionHeader`(format version/工作目录/lineage/seed) | 扁平字段: `ts/initiator/method/url/reqHeaders/reqBody/resHeaders/resBody/durationMs/replayOf?/error?`; `req/resBody` 带 `truncated`/`bytes` 标记 |
| 敏感信息 | 无专门 redaction(事件本身是 agent 上下文) | **credential redaction** 是一等关注: req/res 头身先脱敏再入记录(`redactCredentials`) |
| 归属 | 会话(id) 天然归属 | `initiator` 字段归属(core/replay/插件名) |

### 2.2 持久化模型

| 维度 | dsh | nx-pn (本项目) |
| - | - | - |
| 单元 | 每个 session 一个 append-only 文件(JSONL, zstd 帧或裸行) | 内存 `AuditRingBuffer`, 上限 1000, 超限单调淘汰最旧 |
| 写路径 | `handle.append(events)`(best-effort) + `flush()`(durability barrier) | `push(record)` → `onPush` 同步广播 WS(`audit.append`); 无 flush 概念 |
| 崩溃恢复 | torn-tail 防护, 读不露未写完尾部; lazy materialization | 无(内存, 进程重启丢全部) |
| 落盘介质 | 可换后端: JSONL 文件 / SQLite / 自有实现(实现 `ctx.sessionPersistence` 契约) | 无后端; JSONL 持久化仅 `ring-buffer.ts` 注释提及, 未见实现接线 |

### 2.3 查询/重放/恢复

| 维度 | dsh | nx-pn (本项目) |
| - | - | - |
| 读 | `handle.read(offset,length)` 返回连续校验前缀; `stat(id)` 拿 header+revision | `ringBuffer.snapshot()` / `.since(sinceId)` / `.get(id)` |
| 重放 | session-projection 家族把事件投影为可查询状态 | `/api/replay` 用 `ringBuffer.get(recordId)` → 重发请求(记 `initiator: replay:<id>` + `replayOf`) |
| 断线对账 | (会话恢复 seam) | WS `snapshot.respond`(`auditLastId`/records) 客户端重连后增量同步 |

### 2.4 所有权与并发

| 维度 | dsh | nx-pn (本项目) |
| - | - | - |
| 写者 | `create`/`open(id,'write')` 单写者所有权; 第二写者拒绝(`SessionAlreadyOwnedError`) | 单进程单 ring buffer; 无所有权概念(所有写都走同一 buffer) |
| 关闭/清理 | `close()` idempotent + 排空 durable; 后台写失败暂停自动路径, 下次 flush 重试 | 无(内存 buffer `clear()` 即丢) |

### 2.5 错误语义

| 维度 | dsh | nx-pn (本项目) |
| - | - | - |
| 稳定错误码 | `SessionAlreadyOwnedError`, `SessionAlreadyExistsError`, `SessionReadOnlyError`, `SessionHandleClosedError`, `SessionOwnershipLostError`, `AggregateError`(flush 聚合) | 审计读失败面: 无稳定码(ring buffer 空取回 `undefined`; 重放 `record-not-found` 是路由层) |

## 三、规模对照

| 指标 | dsh | nx-pn (本项目) |
| - | - | - |
| 会话/日志相关包数 | 9+ (`session-persistence`, `-jsonl`, `-projection`, `-cache`, `-stats`, `-telemetry`, `-title*`, `-turn-outline` …) | 0(单 `ring-buffer.ts`) |
| 持久化后端 | JSONL(含 zstd 压缩)+ 可自实现 | 内存 ring buffer + 注释里的 JSONL 愿景 |
| 审计记录的消费 | 投影(query)/统计/telemetry(OTel)/标题生成 多路 | WS 广播 + /audit 页表 + /replay 页重放 |
| 恢复语义 | flush 屏障、torn-tail、crash recovery | 重启丢审计, 插件重放但审计记录不重放 |

## 四、现象与差异

- **两方审计的"记录对象"根本不同**: dsh 审计 agent **会话事件**(可重放整个会话上下文), nx-pn 审计 **HTTP 请求**(带 credential redaction 的请求/响应快照, 供审计工作台展示 + 单请求重放)。这不只是规模差异, 是产品定位差异 —— dsh 是 agent harness, nx-pn 是 API 审计工作台。
- **dsh 的会话事件持久化是核心目标**(append-only + flush 屏障 + torn-tail + 单写者所有权 + crash recovery 全套), **nx-pn 的审计记录默认只在内存**(容量 1000 环形缓冲, 进程重启即清空); nx-pn 把「审计记录要能跨重启留存」留给了注释里未实现的 JSONL 愿景。
- **nx-pn 的「持久化缺口」是审计记录而非插件**: 插件本体持久化是完整的(zip/编译产物/installed.json/重启重放), 但审计记录这条最像"日志"的数据流反而没落盘。dsh 反之 —— 会话日志持久化最完善。
- **dsh 对"审计的可观测/可投影"分家**: session-projection/stats/telemetry 从事件日志派生态; nx-pn 的审计记录是单一结构, 由 /audit 页实时表 + WS 广播直接呈现, 没有独立的投影/统计层。
- **错误语义差距**: dsh 给每条失败路径稳定错误码(Session*Error), nx-pn 审计层基本无错误码(记录读回空值静默、重放失败是 HTTP 路由码)。

## 参考 (Reference)

- dsh: `.claude/repo/deepseek-harness/packages/session/{session-persistence,session-persistence-jsonl}/README.md`
- nx-pn: `packages/host/src/client/ring-buffer.ts`, `packages/host/src/client/audit-record.ts`, `packages/host/src/cordis/host-context.ts`(`AuditStoreService`), `packages/host/src/index.ts:79`(ring buffer 构造 + onPush→WS), `packages/client/src/snapshot/snapshot.ts`
