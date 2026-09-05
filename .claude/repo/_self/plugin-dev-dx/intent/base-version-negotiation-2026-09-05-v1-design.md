# base-version-negotiation — 插件与底座的版本协商

> **Date:** 2026-09-05
> **Topic:** plugin-dev-dx
> **类型:** intent doc(预测设计 · 2c)
> **版本:** v1(首次产出)
> **状态:** 试验(声明位置等关键点待拍板)
> **核心问题:** 插件项目需要的底座能力/版本与实际在线底座之间没有协商通道 —— 旧底座 + 新插件 = 运行时才以"功能找不到/404"暴露,排障成本高。补一个"宿主自报版本 → 插件声明需求 → dev 边界校验"的最小协商层。

## 原始请求(用户原话)

> 但是我现在的问题是 开发插件的时候 主动启动core npx ... ,这种方式的时间和最终不可控呀 而且底座往往更新 会默认本地的命令行,况且我感觉使用命令行代理启动不是很专业 给我一些方案

## 轻微重写版(仅修错别字与口癖)

> 但我现在的问题是:开发插件的时候要主动启动 core(`npx …`),这种方式的时间和最终结果不可控;而且底座更新后,实际用的还是默认的本地命令行版本;况且我感觉用命令行代理启动不是很专业。给我一些方案。

## 本版要验证的假设

**在 dev 上传前做一次 GET /api/version + semver 比较,可以把"旧底座跑新插件"的失败从运行时的零散 404/静默缺失,收敛为一条带升级指引的启动期明确错误** —— 且协商开销对 dev 循环不可感知(单次毫秒级请求)。

## 一、设计原则

| # | 原则                  | 体现                                                                |
| - | --------------------- | ------------------------------------------------------------------- |
| 1 | 声明在插件,校验在边界 | 插件声明最低底座版本;dev.mjs 在连接/上传前校验,宿主上传端点二次校验 |
| 2 | 宿主自报              | 底座暴露 GET /api/version —— 一切校验以宿主自报为准,不猜环境      |
| 3 | 温和降级              | 不满足 → 明确错误 + 升级指引,不自动杀进程、不静默跳过              |
| 4 | 声明式最小面          | v1 只做"最低版本"标量;capabilities 集合(端点存在性)留作演进         |

## 二、模块拆分

```
packages/host/src/server/
├── http-server.ts        [改] 路由表 + GET /api/version
└── version-route.ts      [新] 返回 { version, family } (读 cli package.json version 注入)

packages/host/src/server/plugin-route.ts
                          [改] POST /api/plugins(install/start)响应附带 hostVersion;
                               上传路由校验 zip manifest.minHost(若声明)→ 409 + 指引

packages/client/src/host-api.ts
                          [改] fetchHostVersion(base)

packages/core/src/manifest.ts + schema
                          [改?] manifest 可选字段 minHost?: string(待拍板 #1)

apps/cli/templates/plugin-basic/
├── package.json          [改] "engines": { "@flowot/nx-pn": ">=0.3.4" }(待拍板 #1)
└── scripts/dev.mjs       [改] ensureHost 探测成功后 → fetchVersion → compare → pass/fail
```

## 三、数据流(关键场景)

**场景 1 · dev 冷启动校验**

```
npm run dev
  → probeHost ok → GET /api/version → { version: "0.3.2" }
  → 读本项目声明 engines["@flowot/nx-pn"] = ">=0.3.4"
  → semver 不满足 →
    [dev] ✗ 底座版本不满足:在线 0.3.2 < 需要 >=0.3.4
    [dev]   项目内升级: npm update @flowot/nx-pn 后重启 dev(将自动拉起项目内新版)
    [dev]   若要继续使用在线实例: 请升级该底座后重试
    → 退出(非零码)—— 不带病上传
```

**场景 2 · 共享在线实例 + 项目锁定新版(与 workspace-base 场景 3 衔接)**

```
dev 会话中底座是在线旧实例;项目 lockfile 已是新版
  → 校验失败 → 提示"项目内底座为 0.3.4,在线实例 0.3.2"
  → 用户决策:a) 停掉在线实例,dev 自动拉起项目内新版
             b) 显式 NX_PN_HOST_CMD/手动启动新版
  (v1 不自动杀进程 —— 温和降级原则)
```

**场景 3 · 上传端二次校验(防直接 REST 绕过 dev)**

```
POST /api/plugins (zip)
  → manifest.minHost 声明且 > 宿主版本 → 409 { code: 'plugin/host-too-old',
      message: 'requires host >=0.3.4, this host is 0.3.2' }
```

## 四、关键决策(含选型说明)

| # | 决策                         | 结论                                                           | 理由                                                                                     | 备选(为何不选)                         |
| - | ---------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------- |
| 1 | 声明位置                     | **package.json engines + manifest.minHost 双写**(待拍板) | engines 管 dev 态(项目级,npm 生态惯例);minHost 管发布产物(装到任何宿主都自带门槛)        | 只选其一 → dev 或发布场景缺保护       |
| 2 | semver 解析                  | 手写微型 comparator(仅支持`>=x.y.z` / `^x.y.z`)            | 底座零 npm 依赖不变量(host 的 server 层目前零依赖)                                       | 引 semver 包 → 破坏零依赖 HTTP 层     |
| 3 | 校验时机                     | dev 启动 + 每次上传前(结果缓存到进程内)                        | 上传是热循环高频路径,缓存后零开销                                                        | 仅启动校验 → dev 中途底座被替换不感知 |
| 4 | 失败行为                     | 报错退出 + 指引,不自动处理                                     | 自动杀在线实例对共享场景破坏性大                                                         | 自动升级/自动重启超出 v1 边界          |
| 5 | 为什么不做 capabilities 探测 | 版本号先行                                                     | 标量比较实现极小;capabilities(如"有无 /start 端点")是版本的超集,可作 v2 演进而协议面不变 | v1 直接上 capabilities → 过度设计     |

## 五、接口 / 代码骨架

```ts
// GET /api/version 响应
{ "ok": true, "data": { "family": "nx-pn", "version": "0.3.4" } }

// version-route.ts 骨架(host)
import { version } from '../../../cli-package-version.js'  // 构建期注入,不跨包 import
sendJson(res, 200, { ok: true, data: { family: 'nx-pn', version } })
```

```js
// dev.mjs 校验骨架
let hostVersionCache = null
async function checkBaseVersion() {
  if (!hostVersionCache) {
    const res = await fetch(`http://localhost:${port}/api/version`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
    if (!res?.ok) return true            // 旧底座无此端点 → 视为不满足?否——待拍板 #2
    hostVersionCache = (await res.json()).data.version
  }
  const need = pkg.engines?.['@flowot/nx-pn']        // ">=0.3.4"
  if (!need) return true
  if (!satisfies(hostVersionCache, need)) {
    console.error(`[dev] ✗ 底座 ${hostVersionCache} 不满足 ${need} — npm update @flowot/nx-pn 或升级在线实例`)
    return false
  }
  return true
}
```

```jsonc
// 模板 package.json 增量
{ "engines": { "@flowot/nx-pn": ">=0.3.4" } }   // init.ts 注入,与 workspace-base 版本同源
```

## 六、职责边界

| 关注点           | 负责                                 | 不负责                                    |
| ---------------- | ------------------------------------ | ----------------------------------------- |
| 版本自报         | host /api/version                    | —                                        |
| dev 态校验与指引 | dev.mjs                              | 不做自动升级/杀进程                       |
| 发布态门槛       | 上传端点 manifest.minHost 校验       | 不校验 npm 通道(install 已有宿主版本语境) |
| 版本声明         | 插件项目(engines)/插件产物(manifest) | —                                        |
| "用哪个底座"     | workspace-base 稿                    | 本稿只判"匹配否"                          |

## 七、改动范围(影响面)

| 模块                      | 现状               | 改后               | 影响                                |
| ------------------------- | ------------------ | ------------------ | ----------------------------------- |
| host HTTP 路由            | 无 /api/version    | 新只读端点         | 零破坏;旧客户端不感知               |
| plugin-route/upload-route | 上传不校验宿主版本 | minHost 声明时 409 | 仅影响声明了 minHost 的 zip         |
| client host-api           | 无版本封装         | fetchHostVersion   | 增量 API                            |
| core manifest schema      | 无 minHost         | 可选字段           | 向后兼容(可选);需过 pnpm check:spec |
| template package.json     | 无 engines         | engines 声明       | 新项目默认受保护                    |

## 八、迁移 / 实施路径

1. host /api/version + client 封装(独立验收:curl 可读)
2. dev.mjs 启动校验 + 失败指引(独立验收:旧底座场景报错清晰)
3. manifest.minHost 可选字段 + 上传端 409(独立验收:构造声明 zip)
4. 模板 engines 注入(与 workspace-base 同一 init.ts 改动合流)
5. 随 0.3.4 发版

## 九、验收标准

| # | 验证项           | 方法                                                                           |
| - | ---------------- | ------------------------------------------------------------------------------ |
| 1 | 版本自报         | `curl :4560/api/version` 返回与 cli package.json 一致的版本                  |
| 2 | 旧底座明确报错   | 底座 0.3.2 + 项目声明 >=0.3.4 → dev 启动即报错并给出两条升级路径,非零退出     |
| 3 | 满足时零干扰     | 版本满足 → dev 循环行为与现状完全一致(热部署秒级)                             |
| 4 | 上传端二次门槛   | zip 声明 minHost=0.3.4 → 对 0.3.2 宿主 POST 返回 409 code=plugin/host-too-old |
| 5 | 无端点旧底座行为 | 无 /api/version 的老底座 → dev 按拍板#2 的既定行为执行(警告继续或拒绝)        |
| 6 | 校验零拖累       | 热循环单次上传路径无新增网络请求(版本结果缓存)                                 |

## 十、待用户拍板的决策

| # | 决策                              | 推荐                                                              |
| - | --------------------------------- | ----------------------------------------------------------------- |
| 1 | 声明位置:engines / minHost / 双写 | **双写**(dev 与发布两态都受保护;成本仅一个可选字段)         |
| 2 | 老底座(无 /api/version)的行为     | **警告继续**(过渡期友好;错误码路径只对"有端点且不满足"生效) |
| 3 | 校验失败是否阻断上传              | 阻断(退出)—— 带病上传的排障成本远高于一次重启                   |
| 4 | hostVersion 注入方式              | 构建期从 cli package.json 生成常量文件,运行期零 IO                |

## 十一、参考

- `workspace-base-2026-09-05-v1-design.md`(本稿的场景 1/2 即其场景 3 的冲突出口)
- `../../project/compare_dev-dx-2026-09-05-v1-status.md` §2.6(底座升级影响:三重漂移)
- 现状代码:`packages/host/src/server/http-server.ts`(路由表)、`apps/cli/templates/plugin-basic/scripts/dev.mjs:88-104`(probeHost/waitForHost 可复用)
- koishi 佐证:lockfile 同仓锁版本使协商不必要;nx-pn 因"底座环境级"才需要此层(workspace-base 落地后协商对象收敛为"在线共享实例 vs 项目锁定版")
