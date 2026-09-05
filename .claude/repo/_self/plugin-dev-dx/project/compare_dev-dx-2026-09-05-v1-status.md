# compare_dev-dx — 插件开发者体验三方对比(koishi / dsh / nx-pn)

> **Date:** 2026-09-05
> **Topic:** plugin-dev-dx
> **类型:** project doc(比较文档 · 现状快照)
> **版本:** v1(首次产出)
> **对比对象:** koishi(`.claude/repo/koishi`,commit 5525cfd)、deepseek-harness(`.claude/repo/deepseek-harness`,0.1.2-rc.1)、nx-pn 本项目(0.3.3)
> **关联文档:** `../koishi-hot-reload/project/hot-reload-and-plugin-dev-2026-09-05-v1-concepts.md`(koishi 热加载机制概念阐述)

## 0. 原始问题(用户原话)

> 比较koishi和deepseekharness 如何实现插件开发者 直接就能启动底座 支持插件热更新 当前nx-pn的插件开发者比较麻烦 ,底座要更新,koishi如何做到无感插件run dev

## 1. 三方模型一句话

- **koishi**:插件项目脚手架 = "插件 + 宿主应用" 的 workspace monorepo —— 底座就在项目里,`npm install` 一次全装,`npm run dev` 启动自带底座 + esbuild-register 直吃 TS 源码 + 进程内 HMR。
- **dsh (deepseek-harness)**:底座 = 一个自带全部插件包的 npm CLI(`npx @deepseek-ai/dsh web`);用户插件是 overlay 行(`cordis.patch.yml` 引用相对路径模块);开发态用 repo checkout 的 vendored cordis + `node --import tsx bin.js`。
- **nx-pn (0.3.3)**:底座 = 环境里的长驻宿主(全局 nx-pn / npx 缓存 / NX_PN_HOST_CMD);插件 = 双半区 zip 产物,dev.mjs 监听源码 → 构建 zip → HTTP 热上传 → runId dedup 热替换。

## 2. 逐维对比表

### 2.1 底座来源与版本管理

| 对比项     | koishi                                                                                                                                  | dsh                                                                                                                                                                                           | nx-pn 现状                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 底座在哪儿 | **插件项目 workspace 内**:模板 devDeps 含 `koishi`、`@koishijs/cli`(提供 `koishi start` 守护进程)、`@koishijs/plugin-hmr` | 单一 npm 包`@deepseek-ai/dsh`(CLI 自带全部插件包,"the shipped CLI already contains both webhook packages; the overlay alone activates them");开发态 checkout 里 `vendor/cordis`(git 锁版) | **机器环境级**:dev.mjs `ensureHost()` 探测 :4560 → `NX_PN_HOST_CMD` / 全局 `nx-pn` / npx 缓存 三级回退(`apps/cli/templates/plugin-basic/scripts/dev.mjs:151-181`) |
| 版本锁定   | 项目 package.json 锁定,`npm update` 项目内升级,机器间可复现                                                                           | npx 拉取 latest;开发态 git checkout 锁定                                                                                                                                                      | **脚手架 package.json 零 @flowot 依赖**(template 的 dependencies 只有 react 系)——插件项目与底座版本无任何锁定关系                                                        |
| 升级动作   | workspace 内`npm update koishi`                                                                                                       | 重新 npx / git pull                                                                                                                                                                           | 手动`npm i -g @flowot/nx-pn`;2026-09-05 实测:npmmirror 镜像同步滞后 → ETARGET;底座新能力(如 0.3.3 start 端点)必须先升底座才能用                                               |

### 2.2 插件形态与 TS 处理

| 对比项   | koishi                                                                             | dsh                                                                                                                                                          | nx-pn 现状                                                                                            |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 插件单元 | 单`.ts` 文件,命名导出 `apply(ctx)`(`name` 可选元数据)                        | 单`.mjs`/`.ts`,`export function apply(ctx)`;三种形态(函数/对象/Service 类)                                                                             | **双半区**:`host.ts`(Node 侧)+ `browser.tsx`(UI 侧)+ `manifest.json`,8 文件脚手架         |
| 应用组合 | `koishi.config.yml` 插件表;相对路径键名(`./plugins/foo`)或 `workspace:` 协议 | `cordis.yml` / `cordis.patch.yml` 行:`- name: './hello.ts'`(相对路径或 npm 名);base 本身也是一份 patch 组合(`packages/bundle/base/cordis.patch.yml`) | 底座内置页面 + 上传的 zip 插件;npm 通道`install file:./` 也可                                       |
| TS 处理  | **无构建**:require hook(esbuild-register / tsx)运行时编译源码                | **无构建**:`node --import tsx bin.js`(教程)                                                                                                          | **必有构建**:esbuild bundle host/browser → zip(dev.mjs 每轮变更都跑 `scripts/build-zip.mjs`) |

### 2.3 dev 命令与底座拉起

| 对比项       | koishi                                                                                                                 | dsh                                                                        | nx-pn 现状                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 开发者敲什么 | `npm run dev`(模板 scripts 预置 `cross-env NODE_ENV=development koishi start -r esbuild-register -r yml-register`) | 教程:`node --import tsx ../../vendor/cordis/bin.js`;用户场景:`dsh web` | `npm run dev`(dev.mjs):启动时 `ensureHost()` 自动拉起缺失底座(三级探测,Windows 无弹窗 `windowsHide`),随后 watch |
| 底座进程归属 | **dev 自己的子进程**(`koishi start` 守护进程 fork 应用进程,崩溃自动重启、exit 51 fullReload)                   | dev 命令自己就是应用进程                                                   | **外部长驻进程**:dev.mjs 只保证"有个宿主在 :4560",宿主生命周期独立于 dev 会话                                   |
| 冷启动延迟   | npm install 之后的首次 dev ≈ 应用启动秒级                                                                             | 同左                                                                       | 底座已在线时即时连接;冷机走 npx 缓存/全局安装路径                                                                     |

### 2.4 热更新机制与数据流

| 对比项   | koishi                                                                                                         | dsh                                                                                                                   | nx-pn 现状                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 监听     | `@koishijs/plugin-hmr`:chokidar,debounce 100ms                                                               | `@deepseek-ai/cordis-plugin-hmr`:chokidar + picomatch(**base 中默认 `disabled: true`,按 profile opt-in**)   | dev.mjs:`node:fs.watch` recursive,400ms debounce,`SKIP` 过滤构建产物(`dev.mjs:217-231`) |
| 变更分析 | **进程内模块图**:require.cache children 双向传播 accepted/declined(externals→fullReload);插件为重载粒度 | **ModuleJob 依赖图**:`loadDependencies` 递归收集(跳 node_modules/builtins),`hmr/change`/`hmr/reload` 事件 | 无模块图 —— 每次变更整包重建重传;宿主 runId dedup(listById → remove 旧 run)保证同 id 唯一  |
| 失败行为 | 重 require 失败(esbuild BuildFailure)→ code-frame 报错 +**rollback require.cache,旧版继续运行**         | handleError(同源 error.ts 家族)                                                                                       | REST 400/500 错误返回 dev.mjs 控制台;宿主内旧 run 不动(等价"旧版继续运行")                    |
| 状态保留 | fork config + fork.key 原样重挂,插件配置无损                                                                   | cordis patch 行 id 稳定,配置层不变                                                                                    | 无 —— 每次 run 全新 fiber(插件模块态不跨 run;ns storage 域数据持久)                         |

### 2.5 UI 半区热更新

| 对比项         | koishi                                        | dsh                                         | nx-pn 现状                                                                                        |
| -------------- | --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| UI 插件形态    | console 插件(@koishijs/client),需配套前端构建 | web 前端在 base 仓库内,随 base 一起构建发布 | browser.tsx 随 zip 一起上传                                                                       |
| 热更新到浏览器 | 通常需刷新页面(console 插件重载)              | 前端随 base 版本,无独立热更                 | **WS 推送 `browser-half.load`,页面不刷新热换 UI**(三者唯一);dedup 同步发 retract 清旧页面 |

### 2.6 底座升级对插件开发的影响

| 对比项        | koishi                              | dsh                             | nx-pn 现状                                                                                              |
| ------------- | ----------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 谁触发升级    | 开发者在 workspace 内`npm update` | 用户重新 npx / git pull         | 开发者手动升级全局/npx;dev.mjs 不感知底座版本                                                           |
| 版本漂移面    | 无(项目内锁定);lockfile 可复现      | npx latest 语义;开发态 git 锁定 | **三重漂移**:插件项目不知道底座版本;全局装的可能旧;npx 缓存/镜像可能滞后(2026-09-05 ETARGET 实录) |
| 底座 API 演进 | 插件与底座同仓 lockfile,一起更新    | CLI 整包自洽                    | 底座新端点/新事件(如 0.3.3`plugin.changed`)对旧底座上的插件项目不可见,调试时表现为"功能找不到"        |

## 3. koishi "无感 run dev" 的三个支柱(现状归纳)

1. **底座在项目里**:脚手架产物 = 插件 + 宿主应用 workspace;`npm install` 后项目自带锁定版本底座,不依赖机器环境 —— 这是"底座要更新"痛点在 koishi 侧不存在的结构性原因。
2. **require hook 直吃源码**:`-r esbuild-register` 使 loader 的 require() 运行时编译 .ts;无构建步骤,保存即达。
3. **进程内插件级 HMR**:chokidar → 模块图分析 → registry.delete + fork 重挂(配置保留);编译失败 rollback 旧版继续运行;守护进程兜底崩溃重启(exit 51 契约)。

## 4. nx-pn 的结构性差异(现状陈述)

nx-pn 的插件是**上传给长驻宿主的打包产物**(zip over HTTP),koishi/dsh 的插件是**应用进程加载的磁盘源码模块**。该差异的两侧:

**由此获得**:宿主常驻跨插件会话共享;浏览器半区 WS 免刷新热推(2.5);REST/WS 热替换协议(0.3.3: `/:runId/start`、`plugin.changed` 事件、加载事件调试面板);npm/zip 双分发通道。

**由此付出**:dev 循环必含构建+上传两步(dev.mjs 已自动化,但机制上不可省);插件项目与底座无版本锁定(2.1/2.6);底座升级是独立于插件项目的手动动作;模块级 HMR 不可得(整包粒度)。

## 5. 证据索引

| 事实                                                 | 位置                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| koishi dev 脚本(esbuild-register/守护进程)           | koishi.chat guide/develop/script;koishi`packages/loader`(koishi start 由 @koishijs/cli 提供,不在主仓库) |
| koishi hmr 模块图/rollback/code-frame                | `.claude/repo/koishi/plugins/hmr/src/index.ts`(5525cfd)                                                 |
| ns-require 相对路径解析                              | ns-require paths():`./` → resolve(baseDir, name)(README + 源码验证)                                    |
| dsh apply/cordis.yml/tsx 运行                        | `.claude/repo/deepseek-harness/docs/cordis-tutorial/01-first-plugin.zh.md`                              |
| dsh base=patch 组合、hmr 默认 disabled               | `packages/bundle/base/cordis.patch.yml`(hmr 行 `disabled: true`)                                      |
| dsh vendored hmr(ModuleJob 依赖图)                   | `vendor/hmr/src/index.ts`(loadDependencies)                                                             |
| dsh 用户 overlay 激活本地插件                        | `docs/user/guide/github-review.zh.md:38`、`mcp-memory.md:33`($DSH_HOME/profiles/*/cordis.patch.yml)   |
| nx-pn dev.mjs watch/build/upload/ensureHost 三级探测 | `apps/cli/templates/plugin-basic/scripts/dev.mjs:151-239`                                               |
| nx-pn 脚手架零底座依赖                               | `apps/cli/templates/plugin-basic/package.json`(dependencies 仅 react 系)                                |
| nx-pn 热替换协议(dedup/start/events)                 | `packages/host/src/plugins/loader.ts:153-157`、`server/plugin-route.ts`(start 端点,0.3.3)             |
| 镜像滞后 ETARGET 实录                                | 2026-09-05 会话:registry 源站已全量,npmmirror 未同步完成                                                  |

## 6. 未覆盖/待延伸

- koishi console 插件的前端热更细节(需 console 插件源码,本次未取)
- dsh `cordis-plugin-hmr` 的 `patchReload: live` 配置热应用路径(base 注释提及,未展开)
- nx-pn dev.mjs 在底座版本不满足时的行为(仅 REST 404/功能缺失,无版本协商)
