# storage

**主题**：nx-pn 平台的存储设施——v1 的 audit / plugins / credentials 持久化 + dsh storage 家族移植，v2 的外部插件独立命名空间存储。

**状态**：已落地为 0.3.0 发布（commit `fe6eae4`，10 个家族包到 npm）。本文是设计 + 现状的**导航**：详细分析在 `.claude/repo/_self/storage-audit-comparison/` 下。

## 设计 / 现状文档（按"为什么读 → 读哪份"选）

| 目标                                                              | 读                                                                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| nx-pn 存储**当前是什么样子**                                | [_self/project/compare_storage-arch-…](./.claude/repo/_self/storage-audit-comparison/project/compare_storage-arch-2026-09-04-v1-status.md)          |
| nx-pn 审计日志**当前怎么存、跨重启是否留存**                | [_self/project/compare_audit-log-…](./.claude/repo/_self/storage-audit-comparison/project/compare_audit-log-2026-09-04-v1-status.md)                |
| storage 家族**怎么移植**（hub/backend/domain 的契约与机制） | [_self/intent/dsh-style-storage-port-v1-design](./.claude/repo/_self/storage-audit-comparison/intent/dsh-style-storage-port-2026-09-04-v1-design.md) |
| 外部插件**怎么拿到独立 ns 存储**                            | [_self/intent/plugin-ns-storage-v2-design](./.claude/repo/_self/storage-audit-comparison/intent/plugin-ns-storage-2026-09-04-v2-design.md)           |

> 说明：`_self/` 是设计/盘点文档的存放点（参考 `_self/` 模式），不混入 `references/`。

## 关键决策（跨文档）

| 决策                                                  | 取舍                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| storage 家族零 cordis 依赖（纯库 + 端口接口）         | dsh 用 cordis 插件 + schemastery；nx-pn cordis d.ts 不可用是 shim 存在的根因。用`emit` / `logger` 端口替代 cordis 事件总线 |
| audit 默认 schema 用 zod 宽松结构                     | dsh 用 zod 4 +`z.json()`，nx-pn 引入 zod 4.4.3 依赖                                                                          |
| per-record 布局 + backup-and-skip                     | dsh 的损坏隔离（坏文档读作 absent，绝不 brick unit）                                                                           |
| 插件 ns 域由 host 派生`plugin-<id>`（连字符归一化） | dsh 树内包自己`defineDomain`；nx-pn 第三方不可信代码由 host 强隔离                                                           |
| 配额：v1 1000 记录/表（大小配额 TODO）                | dsh 不做强制配额；nx-pn 选保守基线 + 留扩展点                                                                                  |
| 旧`installed.json` / 审计内存态不迁移               | MVP 数据，放弃而非迁移（设计决策）                                                                                             |

## 抽象层

- **hub 零 IO**：后端拥有 medium，domain 拥有语义+内存+写链
- **写链串行**：durability → 内存 → 事件（rejected write 内存不动，读写永不 diverge）
- **per-record 布局**：单条 atomic rename，损坏隔离（坏文档读作 absent，不 brick unit）
- **纯库 + 端口接口**：`emit` / `logger` 两个端口替代 cordis 事件总线，cordis 装配收敛到 host 薄层
- **域名由 host 派生**：第三方不可信代码拿不到自己名下的存储

## 与代码的对应

| 文档概念                                | 代码位置                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| storage 家族 4 包                       | `packages/storage/{storage,storage-json,storage-sqlite,storage-domain}/`                            |
| audit domain spec                       | `packages/host/src/domains/audit-domain.ts`                                                         |
| plugins domain spec                     | `packages/host/src/domains/plugins-domain.ts`                                                       |
| credentials domain spec                 | `packages/host/src/domains/credentials-domain.ts`                                                   |
| 插件 ns 域 + 句柄                       | `packages/host/src/cordis/plugin-storage-service.ts`                                                |
| 写链串行（audit 中间件）                | `packages/host/src/client/audit-middleware.ts`                                                      |
| WS RPC <br />帧（`plugin-storage.*`） | `packages/host/src/ws/rpc-bridge.ts` + `packages/host/src/index.ts`（`handleBrowserInvoke` 段） |
| 安装 ledger 走 domain                   | `packages/host/src/plugins/installer.ts`                                                            |
| 插件加载 ctx 注入                       | `packages/host/src/plugins/loader.ts`（`Object.defineProperty` 非枚举 wrap）                      |

## 何时读这份 ref

- 给插件作者说明持久化能力时（外部插件的 ns 存储、跨重启留存）
- 排查 audit 记录为什么丢失 / 为什么没跨重启保留
- 评估新存储后端（SQLite / 自定义 backend）的接入路径
- 修改 audit middleware 写链 / 配额策略前的设计参考
