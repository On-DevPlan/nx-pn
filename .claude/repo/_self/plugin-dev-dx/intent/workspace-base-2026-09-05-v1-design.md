# workspace-base — 底座锁定进插件项目

> **Date:** 2026-09-05
> **Topic:** plugin-dev-dx
> **类型:** intent doc(预测设计 · 2c)
> **版本:** v1(首次产出)
> **状态:** 候选(推荐方案,实现成本低)
> **核心问题:** 插件 dev 循环把底座供给交给环境(npx/全局),启动时间与版本双不可控 —— 把底座锁进插件项目 devDependencies,dev 零网络、零 npx、版本可复现。

## 原始请求(用户原话)

> 比较koishi和deepseekharness 如何实现插件开发者 直接就能启动底座 支持插件热更新 当前nx-pn的插件开发者比较麻烦 ,底座要更新,koishi如何做到无感插件run dev

> koishi  dsh 哪个更适合我的场景呀 类似于统一的网络管理层,页面作为插件

> 但是我现在的问题是 开发插件的时候 主动启动core npx ... ,这种方式的时间和最终不可控呀 而且底座往往更新 会默认本地的命令行,况且我感觉使用命令行代理启动不是很专业 给我一些方案

## 轻微重写版(仅修错别字与口癖)

> 比较一下 koishi 和 deepseek-harness 如何实现"插件开发者直接就能启动底座、支持插件热更新"。当前 nx-pn 的插件开发者比较麻烦,底座要手动更新。koishi 是如何做到插件 `run dev` 无感的?

> koishi 和 dsh 哪个更适合我的场景?场景类似于:统一的网络管理层,页面作为插件。

> 但我现在的问题是:开发插件的时候要主动启动 core(`npx …`),这种方式的时间和最终结果不可控;而且底座更新后,实际用的还是默认的本地命令行版本;况且我感觉用命令行代理启动不是很专业。给我一些方案。

## 本版要验证的假设

**把底座作为 devDependency 锁进插件项目后,dev 循环可以在完全离线的机器上冷启动跑通,且全程不产生任何 npx/网络子进程** —— 以此消灭"时间不可控 + 版本漂移 + 命令行代理"三个痛点。

## 一、设计原则

| # | 原则         | 体现                                                         |
| - | ------------ | ------------------------------------------------------------ |
| 1 | 项目即真相   | 底座版本由插件项目 package.json + lockfile 决定,不看机器环境 |
| 2 | 零网络 dev   | `npm install` 之后,`npm run dev` 的任何路径不再触网      |
| 3 | 直接进程调用 | `node <path>/bin/nx-pn.mjs` 直调,无 npx/shell 代理层       |
| 4 | 渐进兼容     | 0.3.3 已发布的三级探测保留为兜底,不破坏存量用户              |

## 二、模块拆分

```
apps/cli/templates/plugin-basic/
├── package.json          [改] devDependencies 增加 "@flowot/nx-pn": "{{version}}"
├── scripts/dev.mjs       [改] ensureHost() 探测顺序重构(本地优先),删 npx 缓存分支
└── README.md             [改] 升级指引一行: npm update @flowot/nx-pn

apps/cli/src/init.ts      [改] 脚手架注入当前 CLI 版本到模板 {{version}} 占位符
(与 {{id}}/{{title}} 同机制)
```

不动 host/client/web 任何包 —— 纯模板与脚手架层改动。

## 三、数据流(关键场景)

**场景 1 · 冷启动(全新机器)**

```
git clone / nx-pn init my-plugin
  → npm install                    # 底座随 devDep 装入 node_modules(唯一一次网络)
  → npm run dev
      dev.mjs ensureHost():
        probe :4560 → 无响应
        → 检测 <root>/node_modules/@flowot/nx-pn/bin/nx-pn.mjs 存在
        → spawn('node', [bin, '--no-open', '--port', port], {detached, windowsHide, stdio:'ignore'})
        → waitForHost(30s) → cycle('startup') → build+upload 热部署
```

**场景 2 · 共享在线实例**

```
probe :4560 → 已响应 → 直接连接上传(dev 不拉起,尊重在线实例)
  ⚠ 在线实例可能是旧版本 —— 版本差异的检测/提示移交
    base-version-negotiation 设计稿(衔接点,见「待拍板 #3」)
```

**场景 3 · 底座升级**

```
插件项目内: npm update @flowot/nx-pn → lockfile 更新
  → 若 dev 正在跑: 底座进程仍旧版 → 由 version-negotiation 提示
  → 重启 dev: ensureHost 拉起的就是 lockfile 新版
```

## 四、关键决策(含选型说明)

| # | 决策                        | 结论                                                             | 理由                                                                       | 备选(为何不选)                    |
| - | --------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------- |
| 1 | devDependency vs dependency | **devDependency**                                          | 底座只在开发态需要;插件发布产物(zip/npm 包)不应携带底座                    | dependency 会污染发布包           |
| 2 | 探测优先级                  | probe →**项目本地 bin** → NX_PN_HOST_CMD → 全局(仅警告) | 痛点②:全局版本陈旧"赢了" —— 本地必须最高优先                            | 全局优先=复刻旧痛点               |
| 3 | npx 缓存分支                | **删除**                                                   | npx 路径=时间+版本双不可控的根源(2026-09-05 ETARGET 实录)                  | 保留为最后兜底仍会诱骗用户走 npx  |
| 4 | 调用方式                    | `node <abs>/node_modules/@flowot/nx-pn/bin/nx-pn.mjs`          | .bin/nx-pn 在 Windows 是 .cmd shim,仍经 shell;直调 .mjs 最干净、跨平台一致 | `node_modules/.bin` 通道        |
| 5 | 版本范围                    | `^{{version}}`                                                 | 允许 minor/patch 跟进,lockfile 锁定实际安装版                              | 精确锁定过于僵硬(待拍板#1 可再议) |
| 6 | spawn 参数                  | 保留 detached + windowsHide + stdio ignore                       | 沿用 0.3.3 dev.mjs 已验证行为                                              | —                                |

## 五、接口 / 代码骨架

```js
// dev.mjs — ensureHost() 重构骨架
const LOCAL_BASE = join(root, 'node_modules', '@flowot', 'nx-pn', 'bin', 'nx-pn.mjs')

async function ensureHost() {
  if (await probeHost()) { console.log(`[dev] 已连接运行中的 web（:${port}）`); return }
  const baseArgs = ['--no-open', '--port', String(port)]
  if (dataDir) baseArgs.push('--data-dir', dataDir)

  if (process.env.NX_PN_HOST_CMD) {          // 用户显式指定,次优先
    launchHost(process.env.NX_PN_HOST_CMD, [])
  } else if (await exists(LOCAL_BASE)) {     // ★ 项目锁定底座,最高优先
    console.log(`[dev] 启动项目内底座 ${LOCAL_BASE}`)
    launchHost('node', [LOCAL_BASE, ...baseArgs])
  } else if (hasGlobalNxPn()) {              // 兜底:仅警告,提示升级到项目内方式
    console.warn(`[dev] ⚠ 使用全局 nx-pn(版本未必匹配本项目)— 建议在项目内 npm install 后使用锁定底座`)
    launchHost('nx-pn', baseArgs)
  } else {
    console.warn(`[dev] ⚠ 无可用底座。请在项目内 npm install(devDependencies 含 @flowot/nx-pn)后重试`)
    return
  }
  await waitForHost(30_000) && console.log(`[dev] 底座已就绪（:${port}）`)
}
```

```jsonc
// template package.json(脚手架渲染后)
{
  "devDependencies": {
    "@flowot/nx-pn": "^0.3.3",   // init.ts 注入当前 CLI 版本
    "esbuild": "^0.24.0",
    "typescript": "5.6.3"
  }
}
```

## 六、职责边界

| 关注点             | 负责                             | 不负责                             |
| ------------------ | -------------------------------- | ---------------------------------- |
| 底座版本声明与安装 | 插件项目 package.json + lockfile | dev.mjs 不做版本决策               |
| 底座拉起/探测      | dev.mjs ensureHost               | 不管理底座进程生命周期(拉起后脱离) |
| 版本匹配校验       | base-version-negotiation 稿      | 本稿只负责"用哪个底座"             |
| 底座自身启动逻辑   | @flowot/nx-pn bin                | —                                 |

## 七、改动范围(影响面)

| 模块                  | 现状                      | 改后                                 | 影响                                             |
| --------------------- | ------------------------- | ------------------------------------ | ------------------------------------------------ |
| template package.json | devDependencies 无底座    | +`"@flowot/nx-pn": "^{{version}}"` | 新 init 项目 install 体积 +底座(pnpm store 去重) |
| dev.mjs ensureHost    | 三级:npx 缓存兜底在列     | 本地 bin 最高优先,npx 分支删除       | 存量已 init 项目需手动同步 dev.mjs(README 指引)  |
| init.ts               | 模板变量 {{id}}/{{title}} | +{{version}} 注入                    | 无破坏                                           |
| apps/cli 发版         | —                        | 模板变更随 cli 包发布                | 下一个 patch 版本携带                            |

## 八、迁移 / 实施路径

1. 模板加 devDep + dev.mjs 本地探测(可独立验收:断网冷启动)
2. init.ts 版本注入(可独立验收:新项目 package.json 含正确范围)
3. README 升级指引 + 存量项目手动同步说明
4. 随 0.3.4 发版

## 九、验收标准

| # | 验证项         | 方法                                                                                                            |
| - | -------------- | --------------------------------------------------------------------------------------------------------------- |
| 1 | 断网冷启动     | 新 init 项目 → npm install → 断网(或 hosts 屏蔽 registry)→`npm run dev` 完整跑通:底座拉起 + 首次热部署成功 |
| 2 | 全程无 npx     | dev 运行期间`Get-Process`/`wmic` 观察无 npx/npm 子进程;dev.mjs 源码 grep 无 `npx` 调用                    |
| 3 | 版本锁定       | 新项目 lockfile 中 @flowot/nx-pn 版本 == 脚手架声明版本;`npm update` 后 lockfile 变化且 dev 拉起新版          |
| 4 | 存量兼容       | 无本地底座的旧项目 + 全局 nx-pn 环境 → dev 仍可跑(警告路径)                                                    |
| 5 | Windows 无弹窗 | 拉起底座无新控制台窗口(windowsHide 回归)                                                                        |

## 十、待用户拍板的决策

| # | 决策                           | 推荐                                                      |
| - | ------------------------------ | --------------------------------------------------------- |
| 1 | 版本范围`^` vs 精确          | `^`(minor 自动跟进,lockfile 兜底)                       |
| 2 | 全局兜底保留 vs 彻底删除       | 保留但降为警告级(过渡期)                                  |
| 3 | 在线旧实例冲突行为(dev 场景 2) | 移交 base-version-negotiation 稿:检测 + 提示,不自动杀进程 |

## 十一、参考

- `../../project/compare_dev-dx-2026-09-05-v1-status.md` §2.1(底座来源)、§3(koishi 三支柱)
- `../../intent/plugin-dev-dx-2026-09-05-intent.md`(意图与约束)
- 现状代码:`apps/cli/templates/plugin-basic/scripts/dev.mjs:151-181`(三级探测)、`apps/cli/package.json`(bin 入口 `./bin/nx-pn.mjs`)
- koishi 佐证:模板 workspace devDeps 含 koishi+@koishijs/cli(compare §2.1)
