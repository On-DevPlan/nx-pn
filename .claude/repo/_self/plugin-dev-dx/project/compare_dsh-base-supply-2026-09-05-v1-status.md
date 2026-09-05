# compare_dsh-base-supply — dsh 底座供给机制专项对比(dsh vs nx-pn)

> **Date:** 2026-09-05
> **Topic:** plugin-dev-dx
> **类型:** project doc(比较文档 · 现状快照)
> **版本:** v1(首次产出;与 `compare_dev-dx-2026-09-05-v1-status.md` 三方比较互补,本文聚焦 dsh 源码级)
> **对比对象:** deepseek-harness(`.claude/repo/deepseek-harness`,0.1.2-rc.1)↔ nx-pn 本项目(0.3.3)
> **关联:** `../intent/workspace-base-2026-09-05-v1-design.md`、`../intent/base-version-negotiation-2026-09-05-v1-design.md`

## 0. 原始问题(用户原话)

> dsh如何实现的呢 他是不是也是底座在开发插件实时拉去 详细比较 参考源码

## 1. 一句话结论

**dsh 不是实时拉取底座** —— 它是第三种供给模型:**"安装实例单份共享"**:底座=一次安装的 dsh 进程(锚点定死),插件项目通过 pnpm `link:` 活链进 profile 目录,平台依赖(cordis 等 peers)经符号链回退**消费安装实例自身的那一份**,dev 全程零底座拉取、零平台依赖复制。

## 2. dsh 底座供给四层机制(源码级)

### 2.1 底座锚定:INSTALL_ANCHOR

```ts
// apps/cli/src/profile-boot.ts:75
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
```

运行中的 dsh 进程即底座;版本=你启动它的那个版本(npx 语义)或已安装版本。`prepareProfile()`(profile-boot.ts:119-123)与 `healProfilesModuleFallback()`(profile-boot.ts:162)均以该锚点为参照系 —— **不存在"运行中另拉一份底座"的路径**。

### 2.2 插件安装:`dsh plugin` = pnpm 薄转发器

```ts
// apps/cli/src/plugin.ts — runPlugin(profile, args)
dsh plugin --profile web add ./my-plugin
  → resolveProfileDir($DSH_HOME/profiles/web)      // 首用 initProfile():package.json + cordis.patch.yml + pnpm-workspace.yaml
  → spawnSync('pnpm', args, { cwd: profileDir })    // 原样转发 pnpm 参数
  → reconcilePlugins(before, dir)                   // 按安装态对账
```

两个细节(均有源码注释):

- **路径锚定** `anchorPathSpec()`(plugin.ts:104-113):`.`/`../plugin` 相对 spec 重写为**用户调用目录**的绝对路径 —— 在插件 checkout 里 `dsh plugin add .` 不会误链 profile 自身;`file:` 前缀保留(pnpm 的 link-vs-copy 语义不被改变)。
- **装了即激活** `reconcilePlugins()`(plugin.ts:60-92):pnpm 成功后扫描 installed dependencies,凡解析到声明 `dsh.bundle` 的包自动 append 进 `dsh.profile.bundles` 层栈;卸载/降级丢声明的自动移出。注释明言"按安装态而非依赖 diff 对账 —— `update` 一个新版获得 bundle 声明的包会自动激活"。

### 2.3 平台依赖回退:peers 共享安装实例(核心机制)

```yaml
# initProfile 写入 $DSH_HOME/profiles/<name>/pnpm-workspace.yaml (profile.ts:182-187)
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false        # 插件不自行安装平台 peers
```

```ts
// profile.ts:177-181 注释原文
// The hoisted linker gives out-of-tree plugins a flat node_modules whose
// missing peers (cordis and friends) fall through to the healed
// profiles/node_modules installation fallback, so every plugin shares the
// installation's single cordis instance instead of a duplicate.
```

- `healProfilesModuleFallback()` 每次 boot 修复 `profiles/node_modules`:内部是指向 **dsh 安装自身 node_modules** 的符号链(profile.ts:569-582: "$DSH_HOME/profiles/node_modules mirrors the dsh installation dependency")
- 效果:插件包不携带 cordis副本;hoisted 扁平 node_modules 解析不到的 peers 沿回退链落到**安装实例的单一份** —— 全部插件共享同一 cordis 实例,无版本打架、无重复安装
- Windows 兼容:`ensureSymlink()`(profile.ts:229+)处理 reparse point 与 dsh 管理的 module proxy 替换

### 2.4 热更新:patch live reload(默认)+ 模块 HMR(opt-in)

```ts
// profile.ts:169
export const DEFAULT_PROFILE_PATCH_RELOAD: ProfilePatchReload = 'live'  // 自定义 profile 默认
```

- 用户 patch 层(`cordis.patch.yml`)boot 后被 launcher watch,live 重载
- base 组合中 `@deepseek-ai/cordis-plugin-hmr` 行 `disabled: true`(`packages/bundle/base/cordis.patch.yml`),按 profile opt-in;`patchReload: live` 的 config-watching 走 launcher 的 watch-only fallback,不依赖 hmr 行

## 3. 逐维两列对比(dsh ↔ nx-pn 现状)

### 3.1 底座进程与锚定

| 维度           | dsh                                                             | nx-pn 0.3.3                                                       |
| -------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| 底座是什么     | 一次安装/启动的 dsh 进程,`INSTALL_ANCHOR` 指向其 package.json | 长驻 host 进程,dev.mjs 探测 :4560 后拉起(全局/npx/NX_PN_HOST_CMD) |
| dev 中再拉底座 | **无此路径**(锚点定死)                                    | npx 分支在缓存未命中时联网下载(时间不可控根源)                    |
| 版本确定性     | =启动的 dsh 版本(npx latest 或已安装版)                         | =环境里恰好存在的版本;插件项目无声明                              |

### 3.2 插件项目与链接

| 维度         | dsh                                                                                               | nx-pn 0.3.3                                             |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 插件项目位置 | 开发者自选目录(checkout);profile 在`$DSH_HOME/profiles/<name>`                                  | 开发者目录(脚手架 8 文件)                               |
| 链接方式     | `dsh plugin add .`/`link:` → pnpm 在 profile 目录建立**活链**;copy 语义也可(`file:`) | esbuild 构建 zip → REST multipart 上传(无文件系统链接) |
| 路径锚定     | `anchorPathSpec` 重写到调用目录                                                                 | N/A(上传的是字节流)                                     |
| 激活语义     | 装了即激活(installed-state 对账 +`dsh.bundle` 声明探测)                                         | 上传即激活(runId dedup 同 id 唯一)                      |
| 移除语义     | pnpm remove + reconcile 自动出栈                                                                  | POST /:runId/remove + uninstall(ledger drop)            |

### 3.3 平台依赖解析

| 维度                  | dsh                                                                                           | nx-pn 0.3.3                                                            |
| --------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 插件对平台 SDK 的依赖 | 声明为 peers;`autoInstallPeers: false` 不自装                                               | 脚手架 package.json**零 @flowot 依赖**(模板只带 react 系)        |
| 运行时解析            | hoisted node_modules 回退 →`profiles/node_modules` 符号链 → **安装实例单份 cordis** | host 半:宿主进程内直接消费自身模块;browser 半:zip 内 bundle 的编译产物 |
| 多插件版本冲突        | 结构性不存在(共享同一实例)                                                                    | 不存在(host 侧单进程;browser 半 bundle 自带)                           |

### 3.4 版本管理与升级

| 维度         | dsh                                                                        | nx-pn 0.3.3                                                     |
| ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 插件版本锁定 | profile 目录 lockfile(pnpm)                                                | 无(每次上传即新 run)                                            |
| 平台版本锁定 | 无 lockfile;跟安装实例走                                                   | 无                                                              |
| 底座升级     | 换 npx 版本/重装 dsh;profile 与插件不动(patch 层行 id 寻址,升级不破坏配置) | `npm i -g @flowot/nx-pn`;底座新能力对旧实例上的插件项目不可见 |
| 版本协商     | 无协议;依赖"单一安装实例"收敛(全体插件看同一 cordis)                       | 无协议(待定问题#4 → design 稿 `base-version-negotiation`)    |

### 3.5 热更新通道

| 维度         | dsh                                                       | nx-pn 0.3.3                                                 |
| ------------ | --------------------------------------------------------- | ----------------------------------------------------------- |
| 配置热更     | patch 文件 live reload(默认)                              | 配置无热更(插件无配置系统)                                  |
| 插件代码热更 | opt-in 模块 HMR(vendored chokidar + ModuleJob 依赖图)     | dev.mjs watch → 整包重建 → 上传 → dedup 替换(全程无刷新) |
| UI 半区      | web 前端在 base 仓库,随 base 构建(插件无独立 UI 半区通道) | **browser-half WS 推送免刷新**(dsh 无对应物)          |
| 失败安全     | hmr handleError 家族                                      | REST 错误返回;宿主内旧 run 原样保留                         |

## 4. dsh 模型对 nx-pn 三痛点的覆盖度(现状评估)

| nx-pn 痛点                      | dsh 对应机制                                                                          | 在 nx-pn 的对应物                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ① dev 时底座拉取时间不可控     | 无拉取路径(安装一次)                                                                  | dev.mjs npx 分支(删除中 →`workspace-base` 稿)                             |
| ② 版本漂移(本地旧命令行"赢了") | 单一安装实例收敛 + profile lockfile 锁插件                                            | 无 →`base-version-negotiation` 稿(协议面)/`workspace-base` 稿(项目锁定) |
| ③ "命令行代理启动"不专业感     | `dsh plugin` 仍是 CLI,但语义化为包管理动作(pnpm 转发);底座启动=`dsh web` 一条命令 | dev.mjs spawn npx(改造对象)                                                  |

结构映射事实:`workspace-base` 稿采用 koishi 路线(项目自带底座副本),dsh 路线(安装实例共享 + peers 回退)在两稿中均无对应方案 —— 该路线若引入 nx-pn,形态为"宿主暴露平台 SDK 模块解析回退 + 插件以 link 方式挂载",属协议外的文件系统层改动,未开稿。

## 5. 证据索引

| 事实                           | 位置                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| INSTALL_ANCHOR 锚点            | `deepseek-harness/apps/cli/src/profile-boot.ts:74-75`                       |
| dsh plugin = pnpm 薄转发       | `apps/cli/src/plugin.ts:120-160`(runPlugin)                                 |
| 路径锚定 anchorPathSpec        | `apps/cli/src/plugin.ts:104-113`                                            |
| 装了即激活 reconcilePlugins    | `apps/cli/src/plugin.ts:60-92`                                              |
| peers 共享注释原文             | `packages/boot/app-boot/src/profile.ts:177-187`                             |
| profiles/node_modules 回退修复 | `profile.ts:569-582`(healProfilesModuleFallback 调用于 profile-boot.ts:162) |
| patch live reload 默认         | `profile.ts:169`(DEFAULT_PROFILE_PATCH_RELOAD='live')                       |
| base hmr 默认 disabled         | `packages/bundle/base/cordis.patch.yml`(hmr 行 `disabled: true`)          |
| nx-pn dev.mjs 三级探测         | `nx-pn/apps/cli/templates/plugin-basic/scripts/dev.mjs:151-181`             |
| nx-pn 脚手架零底座依赖         | `nx-pn/apps/cli/templates/plugin-basic/package.json`                        |

## 6. 未覆盖/待延伸

- dsh 插件作者从 `dsh plugin add .`(copy)到 `link:`(活链)的实际迭代体验差异(文档未明示 dev 推荐,源码注释仅提示语义差异)
- `healProfilesModuleFallback` 的完整实现(profile.ts 500+ 行区域)未逐行核读
- dsh vendored hmr 的 ModuleJob 机制与 koishi hmr 的谱系差异(同源演化程度)
