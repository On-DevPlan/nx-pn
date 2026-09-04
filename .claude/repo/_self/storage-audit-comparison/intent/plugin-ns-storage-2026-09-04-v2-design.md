Intent: 外部插件的独立命名空间存储（per-plugin ns storage）

> **Date:** 2026-09-04
> **Topic:** storage-audit-comparison
> **类型:** intent doc(预测设计)
> **版本:** v2（相对 v1 `dsh-style-storage-port`：v1 解决 host 自身数据的持久化；v2 回答「外部插件如何拿到独占存储」——v1 的 domain 机制之上，增加 host 强制的 per-plugin 命名空间与授权面）
> **状态:** 试验
> **核心问题:** 第三方插件（npm/zip 装入的不可信代码）如何在 host 强制的独立命名空间里持久化自己的数据，且 host 自身数据与插件间、插件与插件间互不越界

原始请求（用户原话）

> "外部插件如何用于独立ns的存储领域 外部插件的数据如何进行ns的持久化 用于维护自身插件"

轻微重写版（仅修错别字与口癖）

> "外部插件如何用于独立 ns 的存储领域？外部插件的数据如何进行 ns 的持久化，用于维护自身插件？"

本版要验证的假设

1. 插件存储面可以完全复用 v1 的 storage 家族：`pluginStorage` 是 storage-domain 之上的**授权门面**，不是新的 backend/form——零新存储机制。
2. `manifest.id`（`^[a-z0-9-]+$`）作 domain/table 名安全可用，无需第二套命名约束。
3. 插件身份在 host 半区可由 cordis fiber.uid → lifecycle 反查（`callerInitiator` 同款机制），在浏览器半区可由 `pluginRunId`（WS rpc.invoke 帧已携带）反查——两条通道都已存在，无需新归因机制。

一、与 dsh 的差异（为什么不能照抄这一段）

| 维度 | dsh | nx-pn 外部插件 |
| --- | --- | --- |
| 代码来源 | 树内可信包，defineDomain 自由声明域名 | npm/zip 第三方，域名若插件自取则可抢占 `audit`/`plugins` 等保留名，或两插件同名互踩 |
| 域名命名空间 | 域名即命名空间（扁平 + already-open 单实例） | 需要 host 强制的 per-plugin 隔离：域名 = 插件身份的派生，不是插件的选择 |
| 生命周期 | 树内包自己 open/close（ctx.effect） | 插件 fiber 卸载时 host 必须保证 domain 关闭——插件忘关不能泄漏句柄 |
| 授权 | 无（可信环境） | host 白名单 + 大小配额，不可信代码只能拿自己名下的存储 |

dsh 的 `workspace` / `message-feedback` / `session-projection-cache` 全是树内包声明域名；树外插件在 dsh 中不是一等公民。所以这一段**不能**照抄，但底层（KvUnit 契约、写链、原子写、错误码）100% 复用。

二、设计原则

| # | 原则 | 体现 |
| - | --- | --- |
| 1 | 域名 = `plugin-<manifest.id>`，host 派生，插件不可选 | 前缀 `plugin-` 合法（`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`），保留名 `audit`/`plugins`/`credentials` 天然不可抢占 |
| 2 | 插件拿句柄不拿域名：`ctx.pluginStorage` 是授权门面 | 插件代码只见到 `ctx.pluginStorage` 接口，见不到 storageDomain/backend/文件路径 |
| 3 | 身份从执行上下文强制派生，不信插件自报 | host 半区：callerInitiator（fiber.uid→lifecycle）；浏览器半区：rpc.invoke 帧 `pluginRunId`→lifecycle |
| 4 | 生命周期随 fiber：fiber 卸载 → domain.close()（写链 drain） | host 持 open 注册表（pluginRunId→domain），插件无权 close |
| 5 | 配额 + 保留名 fail-loud | `quota-exceeded` / `plugin-ns-denied` 稳定错误码 |

三、模块拆分

```
packages/storage/storage-domain/          （v1 已有，不动）
packages/host/src/cordis/
├── plugin-storage-service.ts   NEW  PluginStorageService（'pluginStorage' cordis 服务）
│     - host 半区插件 apply(ctx) 里 ctx.pluginStorage 可用
│     - open 名称空间 = plugin-<manifest.id>，version=1 固定
│     - 每插件单 open：lifecycle 注册时 host 代 open，注入 ctx；fiber 卸载时 host 代 close
packages/host/src/plugins/
├── lifecycle.ts                改   register 时同步 open ns-domain；remove 时 close（写链 drain 保证不丢数据）
├── loader.ts                   改   注入：host 半区模块在 import 后、apply 前由 host wrap ctx
packages/host/src/cordis/
└── host-context.ts             改   installCoreServices 增 PluginStorageService
```

四、数据流（关键场景）

### 4.1 插件存取自己的数据（host 半区）

```
插件 host.ts:
  export default (ctx) => {
    const store = ctx.pluginStorage                       // host 注入的门面句柄
    await store.table('settings').put('theme', { dark: true })   // 写 = durable → 内存 → （host 监听 domain/changed，如需 WS 通知）
    const v = store.table('settings').get('theme')               // 读 = 同步内存
    await store.table('settings').update('theme', r => ({ ...r, dark: false }))
  }

物理落点（json backend per-record layout）:
  <dataDir>/storage/plugin-<id>/settings/theme.json        ← 原子写（temp+fsync+rename）
  <dataDir>/storage/plugin-<id>/settings/<key>.json
```

### 4.2 身份强制（host 半区）

```
插件 apply(ctx) 被 host 以 wrap 后的 ctx 调用：
  ctx.pluginStorage = PluginStorageHandle({ id: manifest.id, ns: `plugin-<id>` })
  handle.table(name)  → 只暴露该 ns-domain 的 table（tables 白名单：settings/cache/state 由 host 统一声明在 spec）
  handle.close()      → 不存在（接口上就没有）
```

### 4.3 浏览器半区

浏览器半区无文件系统，存储全走 host RPC：
```
browser half: ctx.pluginStorage.get('settings','theme') / .put(...)
  → WS rpc.invoke frame { pluginRunId, op:'storage.get', table, key }
  → host 按 pluginRunId 反查 lifecycle → 找到该 run 的 ns-domain → 执行 → 回帧
```
配额与白名单在 host 侧统一强制；浏览器半区拿到的是**同一逻辑句柄的 RPC 投影**，与 `ctx.auditClient`（经 auditClient 服务代理）同构。

### 4.4 卸载语义（关键差异点：数据不随插件删，除非用户选删）

```
lifecycle.remove(pluginRunId)
  → domain.close()                    // drain 写链 → backend close → 事件仍发
  → ns-domain 数据保留在 medium       // 插件重装 → 同 id → 同 ns → 数据回来（"维护自身插件"诉求）
  → uninstall（ledger 删除）→ 用户选择是否 purge：
      purge = 删 <dataDir>/storage/plugin-<id>/ 目录树（per-record 布局 = 删目录即删数据）
```

五、接口 / 代码骨架

```ts
// packages/host/src/cordis/plugin-storage-service.ts
export interface PluginStorageHandle {
  readonly ns: string                          // 'plugin-<id>'（诊断只读）
  table(name: PluginTableName): KvTable<string, unknown>   // settings | cache | state
}
// host 侧统一 spec（不是插件 defineDomain！）：
const pluginNsSpec = (id: string) => defineDomain({
  name: `plugin-${id}`, version: 1, layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    settings: domainTable(z.json()),           // 小而关键：配置
    cache:    domainTable(z.json()),           // 可丢弃：invalidRecords skip
    state:    domainTable(z.json()),
  },
})

// lifecycle.register 处：
const domain = await ctx.storageDomain.open(pluginNsSpec(id))   // host 代开
lifecycleEntry.storage = domain                                  // fiber 卸载 → host close

// 插件侧完整用法：
export default (ctx) => {
  ctx.pluginStorage.table('settings').put('kv1', { any: 'json' })
}
```

六、职责边界

| 关注点 | 归属 | 防蔓延 |
| --- | --- | --- |
| ns 命名、授权、配额、保留名 | host（plugin-storage-service） | storage 家族不知道"插件"存在 |
| open/close 生命周期 | host lifecycle（插件无权） | 插件接口无 close |
| 校验 | host 统一 spec 的 zod（`z.json()` 任意 JSON） | 插件不传 schema（v2 从简；插件自定义 schema 留 v3 讨论） |
| 浏览器半区存储 | host RPC handler + pluginRunId 归因 | browser half 不直接见 domain |
| medium 字节正确性 | storage-json / storage-sqlite | 与 v1 相同 |

七、改动范围（影响面）

| 模块 | 现状 | 改后 | 影响 |
| --- | --- | --- | --- |
| packages/host/src/cordis/plugin-storage-service.ts | 不存在 | 新增（~150 行） | 纯新增 |
| packages/host/src/plugins/lifecycle.ts | register/remove 只管 fiber | + ns-domain open/close 钩子 | register 变 async（或预开+异步补） |
| packages/host/src/plugins/loader.ts | ctx 直传 | wrap ctx 注入 pluginStorage | host-compiler 编译产物不受影响（注入在 runtime） |
| plugins/echo（示例） | 无存储 | 加 2 行演示 put/get | 示范插件作者体验 |
| packages/core | 无改动 | 无改动 | manifest.id 无需改 schema（已够用） |
| storage 家族四包 | v1 范围 | 无改动 | 复用 |

八、迁移 / 实施路径

1. **P1（依赖 v1-P1）**：plugin-storage-service + lifecycle 钩子 + loader 注入。验收：echo 插件 put → 重启 host → get 数据仍在；卸载重装数据保留；purge 删除目录树。
2. **P2**：浏览器半区 RPC 通道（storage.get/put op）。验收：echo 浏览器半区写入 → host 落盘文件可见。
3. **P3**：配额（v2 常量：每 ns 5MB/1000 records，超 `quota-exceeded`）。验收：写入超限 fail-loud，既有数据无损。

九、验收标准

| # | 验证项 | 方法 |
| - | ------ | ---- |
| 1 | ns 隔离 | 装两个插件 A/B，各自 put 同名 key 'k' → medium 上 `plugin-a/settings/k.json` 与 `plugin-b/settings/k.json` 独立存在 |
| 2 | 保留名不可抢占 | 插件任何途径拿不到 `audit`/`plugins`/`credentials` domain（接口上不存在该入口） |
| 3 | 生命周期 | 卸载插件 → 其 domain closed（后续任何 storage op 报 closed）；重装 → 数据原样回来 |
| 4 | 崩溃安全 | 写入中 kill -9 → 重启后该 key 要么旧值要么新值（原子 rename 保证），目录树无半写文件 |
| 5 | 跨半区一致 | 浏览器半区 put → host 半区 get 立即可见（同一 domain 内存态） |
| 6 | 数据保留 | uninstall 后 reinstall 同 id → settings/state 表数据完整 |

十、待用户拍板的决策

| # | 决策 | 推荐 |
| - | ---- | ---- |
| 1 | 插件能否自定义 zod schema（v3）还是 v2 只用 z.json() | v2 从简 z.json()；schema 由插件自己读回时校验 |
| 2 | 配额常量（5MB/1000 records）或按 host 配置 | 常量先行 |
| 3 | purge 交互：uninstall 命令带 `--purge` flag 还是独立 `nx-pn purge <id>` | `--purge` flag |
| 4 | 保留名清单（v2：audit/plugins/credentials）是否入 core 常量 | 入 core（manifest 校验层就近可见） |

十一、参考

- v1 设计：`_self/storage-audit-comparison/intent/dsh-style-storage-port-2026-09-04-v1-design.md`（storage 家族移植，本设计的底层）
- dsh 佐证「域名即命名空间、无 per-plugin 隔离」：`storage-domain/src/{spec,index,invariant}.ts`、`packages/workspace/workspace/src/index.ts:120-121`（树内 open 范式）
- nx-pn 身份锚点：`manifest.schema.json` id pattern `^[a-z0-9-]+$`、`host-context.ts:60` callerInitiator（fiber.uid 归因）、`loader.ts` browserSource/`ws/rpc-bridge` pluginRunId（浏览器半区归因）
- nx-pn 现状对比（为什么外部插件需要 host 强制隔离）：`_self/storage-audit-comparison/project/compare_storage-arch-2026-09-04-v1-status.md`
