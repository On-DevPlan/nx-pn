Intent: nx-pn 移植 dsh storage 家族结构，实现持久化存储

> **Date:** 2026-09-04
> **Topic:** storage-audit-comparison
> **类型:** intent doc(预测设计)
> **版本:** v1（首版）
> **状态:** 试验
> **核心问题:** 把 dsh 的 hub/backend/domain 三层存储结构移植进 nx-pn，让审计记录与插件状态跨重启持久化

原始请求（用户原话）

> "dsn底层如何存储的    可插拔:`storage-json`(JSON 文件树), `storage-sqlite`(每记录一行, `node:sqlite`)   我也希望彻底模仿dsn的结构 实现持久化存储"

（上下文前置请求：本 topic 前两轮讨论了"dsh 与 nx-pn 工程结构对比""存储系统/审计日志对比"，用户在读完对比结论后提出移植要求）

轻微重写版（仅修错别字与口癖）

> "dsh 底层如何存储的？可插拔：`storage-json`（JSON 文件树）、`storage-sqlite`（每记录一行，`node:sqlite`）。我也希望彻底模仿 dsh 的结构，实现持久化存储。"

本版要验证的假设

1. dsh 的 backend 契约（KvFacet/KvUnit/descriptor）可以在 nx-pn 的 cordis shim（`minimal-types.ts` 只有 registry/effect/logger，无 provide/events 泛型）上以**等价但更薄**的方式重建，不需要升级 cordis 依赖。
2. 审计记录（AuditRecord）放进 KV domain（key=单调 id）后，ring buffer 可以退化为"domain 内存表的容量视图 + WS 广播挂点"，`since()/snapshot()` 语义不变，`/api/replay` 不需要知道存储换了。
3. JSON 后端 single layout 足够承载 nx-pn 当前所有持久化需求（audit 记录用 per-record，插件 ledger 用 single），SQLite 后端可以同版交付但默认路由 JSON。

一、设计原则

| # | 原则 | 体现 |
| - | --- | --- |
| 1 | 照抄 dsh 三层：hub 零 IO、backend 拥有 medium、domain 拥有语义+内存+写链 | `nx-pn-storage` / `-storage-json` / `-storage-sqlite` / `-storage-domain` 四包，接口名与 dsh 同名（KvFacet/KvUnit/KvUnitDescriptor/UNIT_NAME_RE） |
| 2 | 值在 backend 层不透明，schema 校验只发生在 domain 层 durable 边界 | backend 返回 `unknown`；zod（见决策 D1）只在 open/loadAll/写前出现 |
| 3 | 写序归 domain 写链，backend 只保证单调用原子+durable | 照抄 dsh domain.ts 的 `chain.then(job)` 串行；JSON single 的"失败回滚内存"、per-record 的"目录即状态"各自保留 |
| 4 | 原子发布协议照抄：temp+fsync+rename(+POSIX dir fsync) | `writeAtomic` 逐行移植（含 Windows 分支注释） |
| 5 | fail-loud + 稳定错误码 | StorageError/DomainError：`version-mismatch`/`malformed-medium`/`duplicate-backend`/`backend-not-found`/`invalid-record`/`closed`… |
| 6 | 产品代码不直接碰 backend；一切经 `ctx.storageDomain` | host 的 auditStore/plugins/credentials 服务改为 domain 门面，installer 的 installed.json 并入 domain |

二、模块拆分

```
packages/storage/
├── storage/            @flowot/nx-pn-storage           hub：BackendRegistry + StorageError + UNIT_NAME_RE + 契约类型
│   └── src/{backend,error,registry,index}.ts          （≈ dsh 233 行，几乎逐行移植）
├── storage-json/       @flowot/nx-pn-storage-json      JSON 后端
│   └── src/{atomic,format,single-unit,per-record-unit,index}.ts
├── storage-sqlite/     @flowot/nx-pn-storage-sqlite    SQLite 后端（node:sqlite，Node≥22.5 内建，nx-pn engines ≥22.7 ✓）
│   └── src/{schema,unit,index}.ts
└── storage-domain/     @flowot/nx-pn-storage-domain    domain 数据形
    └── src/{spec,domain,events,error,index}.ts

packages/host/src/cordis/
├── host-context.ts     +StorageHubService('storage') / +StorageDomainService('storageDomain')
│                        installCoreServices 增挂 storage 家族（dataDir 派生 root/path）
├── builtin-plugins/    host 半区插件按需 open domain（audit/plugins/credentials）
packages/host/src/client/
└── ring-buffer.ts      退化为 domain 之上的容量视图（见三.1）；JSONL 愿景注释删除
packages/host/src/plugins/
└── installer.ts        installed.json ledger → domain `plugins` table `installed`（json single layout）
```

三、数据流（关键场景）

### 3.1 审计记录写入（核心改造）

```
auditClient 请求完成
  → audit-middleware 组装 AuditRecord（redact 后）
  → domain 'audit'.table('records').put(String(id), record)     ← per-record layout，key=id（数字单调，路径安全）
      写链排队 → backend.putRecord → <root>/audit/records/000123.json 原子落盘
      → 内存表 set → 发 'domain/changed' {domain:'audit', table:'records', key, operation:'put', value}
  → host 挂 domain/changed 监听：ring-buffer.push(record)（容量窗口维持 1000 观感）
      → broadcast('audit.append', record)（WS 行为与今日完全一致）
```

- `since(sinceId)` / `snapshot()`：继续读 ring buffer（内存窗口），**重启后**从 domain 全量 loadAll 重建窗口 → 跨重启审计留存达成
- `get(id)`：`/api/replay` 先查窗口，miss 时查 domain（recordId 超出窗口仍可重放——比今天更强）
- 审计记录 schema：AuditRecord 各字段补 zod（reqBody/resBody 的 text/truncated/bytes、error 可选…）；`layout:'per-record'` + `invalidRecords:'backup-and-skip'`（单条损坏不 brick，符合审计数据"可丢弃单条、必须整体活着"的性质）

### 3.2 插件安装 ledger

```
npmInstallPlugin
  → npm install --prefix dataDir/plugins-registry   （不变，npm 自己管 node_modules）
  → domain 'plugins'.table('installed').put(id, {spec,name,version,installedAt})   ← single layout
  → installed.json 文件被 domain 取代（json backend 恰好也是可读 JSON 文件，运维体验不降级）
restartFromDataDir：先 open domain 读 ledger，再扫描 zip——zip 本体仍走文件系统（二进制资产，非 KV 数据，不进 domain）
```

### 3.3 credentials（顺手补 MVP 桩）

```
domain 'credentials'：table 'resolved'（hash→secret）或 global 单例
CredentialsService.resolve(hash) 从桩变真实现；"no persistent credential store" 注释删除
```

### 3.4 启动/关闭

```
startHost(opts)
  → new CordisContext()
  → ctx.plugin(storageHub)                        // hub 注册表
  → ctx.plugin(jsonBackend, {root: join(dataDir,'storage')})     // 或 sqlite {path}
  → ctx.plugin(storageDomain, {backend:'json'})   // 路由配置；v1 全 json
  → 三服务 open domain（audit/plugins/credentials）
  → ring buffer 从 audit domain loadAll 重建窗口
stop()/Ctrl-C
  → domain.close()（写链 drain，事件仍发）→ backend.close()（排空 in-flight）→ server 关闭
```

四、关键决策（含选型说明）

| # | 决策 | 结论 | 理由 | 备选 |
| - | --- | --- | --- | --- |
| D1 | domain 记录 schema 用 zod 还是复用 ajv | **zod**（新增依赖） | 彻底模仿 dsh：defineDomain 的 `z.infer` 类型推导 + `safeParse` 边界校验是 dsh 设计的一半价值；ajv 是 JSON-Schema 字符串，类型要手写两遍。core 的 manifest ajv **保持不动**（那是另一条校验线） | ajv 复用（省依赖但写两遍类型；违背"彻底模仿"） |
| D2 | 审计记录进 KV domain 还是仿 session-persistence 做 append-only JSONL | **KV domain（per-record）** | 用户的请求明确指向 storage 家族；AuditRecord 是"可单条寻址、可单条重放"的记录不是流事件；per-record 布局恰好给大 body 免全量重写 + 单条 backup-and-skip。append-only seam（flush 屏障/torn-tail）留作未来第二 seam，不在本版 | session-persistence-jsonl 仿制（多一套 seam，工作量大，且 nx-pn 无会话概念） |
| D3 | ring buffer 保留还是删除 | **保留为容量视图** | WS `since/snapshot` 契约、auditLastId 对账、/audit 页 1000 条观感都依赖窗口语义；domain 是全量持久层，窗口是展示层，两者不冲突 | 删 ring buffer 直接读 domain（每次全表扫描，WS 对账语义要重设计） |
| D4 | id 作 key 的路径安全 | **`String(id)` 十进制数字** | `[a-zA-Z0-9_-]+` 天然满足；单调递增天然唯一 | 零填充（无害，v1 不做） |
| D5 | SQLite 后端本版是否交付 | **交付但默认不路由** | node:sqlite 零依赖成本，契约一致带来互换性；audit 高频写未来可 `routes:{audit:'sqlite'}` 一行切换 | 只交 json（少 400 行，但"彻底模仿"缺一角） |
| D6 | storage 包放 packages/storage/* 还是塞进 host | **packages/storage/**（4 个独立 workspace 包） | dsh 的结构就是独立包家族；未来插件作者可自装 `-storage-domain` 声明自己的 domain | 塞 host/src/storage（少 4 个 package.json，但不是"彻底模仿"） |

五、接口 / 代码骨架

```ts
// packages/storage/storage/src/backend.ts —— 与 dsh 同名同形（移植目标）
export interface StorageBackend { readonly kv?: KvFacet; close(): Promise<void> }
export interface KvFacet { open(descriptor: KvUnitDescriptor): Promise<KvUnit> }
export interface KvUnit {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  deleteRecord(table: string, key: string): Promise<void>
  backupRecord?(table: string, key: string): Promise<string>
  setGlobal(value: unknown): Promise<void>
  close(): Promise<void>
}

// packages/host/src/domains/audit-domain.ts —— 消费方声明
export const auditSpec = defineDomain({
  name: 'audit', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip',
  tables: { records: domainTable<AuditRecordKey, AuditRecord>(auditRecordSchema) },
})

// host-context.ts —— 服务门面签名不变，实现换 domain
proto.snapshot = function () { return windowSnapshot(this) }   // ring buffer 窗口
proto.since   = function (id) { return windowSince(this, id) }
```

六、职责边界

| 关注点 | 归属 | 防蔓延 |
| --- | --- | --- |
| medium 的字节级正确性（原子写/pragma/布局版本） | backend 两包 | domain 层禁止出现 fs/sqlite import |
| schema 校验、写链、事件 | storage-domain | backend 禁止出现 zod/业务 schema |
| WS 广播、窗口语义 | host（ring-buffer + domain/changed 监听） | storage 家族不知道 WS 存在 |
| manifest 校验 | core（ajv，现状不动） | domain schema 不挪去 core，core 保持零 cordis |
| zip/编译产物（二进制资产） | host loader 文件系统路径 | 不进 domain（非 KV 数据） |

七、改动范围（影响面）

| 模块 | 现状 | 改后 | 影响 |
| --- | --- | --- | --- |
| packages/storage/* | 不存在 | 新增 4 包（估 2200 行，大半为 dsh 移植） | 纯新增，零风险 |
| packages/host/src/client/ring-buffer.ts | 内存 FIFO + onPush | 增 domain 重建窗口入口；push 挂 domain/changed | 对 WS 契约零变化 |
| packages/host/src/cordis/host-context.ts | 4 服务 + AuditStoreService 桩 | +storage/storageDomain 服务；auditStore 内部改走 domain | 服务签名不变，插件无感 |
| packages/host/src/plugins/installer.ts | installed.json 手写 | ledger 写 domain | 卸载/列表逻辑同步改；文件形态仍可读 |
| packages/host/src/index.ts | startHost 直构各件 | startHost 增 storage 装配段 + domain open + 窗口重建 | 启动顺序新增依赖：hub→backend→domain→服务 |
| packages/host/package.json | deps 5 项 | +zod +node:sqlite(内建无需声明) | zod 进运行时依赖（esbuild 事故教训：进 deps 而非 devDeps） |
| apps/web / plugins | 无感知 | 无感知 | 0 |

八、迁移 / 实施路径

1. **P1 纯移植**：storage + storage-json + storage-domain 三包照 dsh 落地 + 单测（契约测试：原子性/版本拒绝/损坏隔离/写链串行）。验收：三包独立 vitest 全绿，host 未接线。
2. **P2 audit domain 接线**：audit spec + ring-buffer 窗口重建 + WS 挂点。验收：写 5 条记录 → kill 进程 → 重启 → /audit 页 5 条俱在；/api/replay 对窗口外 id 仍可重放。
3. **P3 ledger + credentials**：installer ledger 迁 domain（首次启动无 domain 数据时保持空、不迁移旧 installed.json，写明放弃）；credentials 桩转真。验收：`add`/`uninstall` 循环后重启，插件列表正确。
4. **P4 sqlite 后端**：照 dsh schema.ts/unit.ts 移植 + 契约测试跑同一套。验收：`storageDomain config routes {audit:'sqlite'}` 一行切换后 P2 验收原样通过。

九、验收标准

| # | 验证项 | 方法 |
| - | ------ | ---- |
| 1 | 跨重启审计留存 | 写 N 条 → 杀进程 → 重启 → /audit 页 N 条、auditLastId 连续 |
| 2 | WS 契约不回归 | 现有 client/host WS 测试全绿；snapshot.respond 字段不变 |
| 3 | 原子性 | writeAtomic 单测：rename 中断模拟（temp 残留不影响旧文件） |
| 4 | 损坏隔离 | 手工破坏一条 000042.json → 重启跳过该条并出 .bak，其余完好 |
| 5 | 版本拒绝 | domain version 改 2 重开 → version-mismatch |
| 6 | 写链串行 | 100 并发 update 同 key → 终值等于第 100 次变换，无交错 |
| 7 | 后端互换 | json/sqlite 路由切换，同一套 domain 测试双跑全绿 |
| 8 | spec 门禁 | pnpm check:spec 通过（新包服务同样走 prototype-method 规则） |

十、待用户拍板的决策

| # | 决策 | 推荐 |
| - | ---- | ---- |
| 1 | D1 zod 新依赖（~50KB gzip）可否接受 | 接受——类型推导是 domain 层价值的一半 |
| 2 | 旧 installed.json / 旧内存审计是否迁移 | 不迁移（MVP 数据，放弃）——若要迁移，P3 增一次性 bootstrap |
| 3 | 审计 domain 是否带 global 槽（如全局序号水位） | v1 不带；lastId 从 records 表 max(key) 派生 |
| 4 | P4 sqlite 与 P1-P3 同版发布还是延后 | 同版（契约测试复用，边际成本低） |

十一、参考

- 现状对比：`_self/storage-audit-comparison/project/compare_storage-arch-2026-09-04-v1-status.md`、`compare_audit-log-2026-09-04-v1-status.md`
- dsh 源码（移植蓝本）：`packages/storage/storage/src/{backend,registry}.ts`、`storage-json/src/{atomic,format,single-unit,per-record-unit}.ts`、`storage-sqlite/src/{schema,unit}.ts`、`storage-domain/src/{spec,domain,index}.ts`
- nx-pn 接线点：`packages/host/src/index.ts:79`（ring buffer 构造）、`packages/host/src/cordis/host-context.ts:115-144`（AuditStoreService）、`packages/host/src/plugins/installer.ts:35`（INSTALLED_JSON）、`packages/host/src/cordis/minimal-types.ts`（shim 能力边界）
