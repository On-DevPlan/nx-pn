# hot-reload-and-plugin-dev 概念阐述(2026-09-05 v1)

> **Topic:** koishi-hot-reload
> **类型:** project doc(模块概念阐述)
> **版本:** v1(首次产出)
> **分析对象:** `.claude/repo/koishi`(commit 5525cfd, 2026-08-29)+ `.claude/repo/koishi-plugin-adapter-onebot` + `.claude/repo/cordis`(版本对照用)

## 1. 整体框架

Koishi 的"热"能力是一个**四层热栈**(hot stack),自下而上层层支撑;插件本身是**无底座的库**,寄宿在宿主应用中,调试开发的本质就是"搭一个带热栈的宿主":

```
┌─ 第3层 fullReload ── 进程级重启(exit 51 + IPC KOISHI_SHARED,守护进程接管)
├─ 第2层 HMR ───────── 插件源码热更新(Watcher:模块图分析→插件级重载事务)
├─ 第1层 配置热应用 ── 改 yaml/json 配置不重启(state.update + accept 原地响应)
└─ 第0层 Loader ────── 启动加载(findConfig→ns-require 解析→group:entry 递归装载)

调试侧支撑:esbuild-register(ts 免构建直跑)+ code-frame(错误帧)+ koishi start(守护进程)
运行底座:   cordis(registry / fork / dispose / accept —— 插件生命周期管理)
```

插件加载的双通道解析(ns-require `paths()`):
- 裸名 `foo` → 先试 `@koishijs/plugin-foo`(official),再试 `koishi-plugin-foo`(namespace)
- `./foo` / `../foo` → `resolve(baseDir, foo)` 相对路径直载,**不走命名空间**
- 绝对路径 → 原样使用

## 2. L1 概念名称表

| 概念名 | 一句话定义 | 首次提出语境 | 与其他概念的关系 |
| --- | --- | --- | --- |
| **Loader** | 加载器抽象基类:配置发现/读取/迁移/插件 import/配置写回(`loader/shared.ts:119`) | 分析启动流程 | NodeLoader 是其 Node 实现;持有 cache/names/store |
| **NodeLoader** | Loader 的 Node 环境实现:ns-require scope 初始化 + fullReload(exit 51 + IPC)(`loader/index.ts:19`) | 读 loader 源码 | 继承 Loader |
| **ns-require / scope.resolve** | 插件名解析器:裸名→`koishi-plugin-*`/`@koishijs/plugin-*`,相对路径→baseDir 解析 | 追问"本地插件如何加载" | NodeLoader.init 时以 `namespace:'koishi', prefix:'plugin', official:'koishijs', dirname:baseDir` 构造 |
| **loader.cache** | 插件名 → 入口文件绝对路径的字典(`cache: Dict<string>`) | 分析 HMR 定位机制 | HMR 遍历它确定"哪些在运行的插件可能受影响" |
| **group** | 内置的可复用(reusable)分组插件,根实例为 `group:entry`;递归 reload/unload 子插件,accept 做增量 diff(`loader/shared.ts:64`) | 读 createApp | 整个插件树的组织者 |
| **registry** | cordis 插件注册表:plugin → runtime 映射;`delete(plugin)` 触发全部 fork 的 dispose 生命周期 | 分析插件卸载 | HMR 重载时先 delete 旧插件 |
| **runtime / MainScope** | registry 中一个插件的主作用域(旧版 cordis 3.x 概念) | 对照 hmr 源码类型 | fork 挂在 runtime 下 |
| **fork / ForkScope** | 同一插件的某一配置实例(多配置 = 多 fork),持有自己的 key 与 config | 分析 HMR 状态保留 | 重载时对每个 fork 用原 config 重新 `parent.plugin()`,fork.key 保留 |
| **ctx.accept** | 插件内注册配置变更回调,**原地响应**不销毁重建(`{passive:true}` 变体) | 分析配置热更新 | 由 fork.update(config) 触发 |
| **fork.update(config)** | 更新某 fork 的配置 → 触发插件内 accept 回调 | 同上 | loader.reload 对已存在 fork 走此路径 |
| **Watcher** | hmr 插件的核心类:`static inject = ['loader']`,持有 chokidar FSWatcher 与四个集合(`plugins/hmr/src/index.ts:40`) | 分析 HMR | 依赖注入 loader 服务 |
| **externals** | 变更必然触发 fullReload 的文件集:从 `require.resolve('koishi')` 遍历 require.cache、排除 loader.cache 中的插件入口、跳过 node_modules | 读源码注释 | analyzeChanges 的 declined 初始值 |
| **stashed** | 暂存的待处理变更文件(防抖窗口内累积) | 同上 | analyzeChanges 的 accepted 初始值 |
| **accepted** | 应被重载的文件集:"某插件 P → 文件 X → 某变更 C"(变更可向上传播到插件入口) | 同上 | 由模块图传播算法计算 |
| **declined** | 不需重载的文件集:"某变更 C → 文件 X → 无任何变更 D"(变更无法继续传播) | 同上 | 含全部 externals |
| **analyzeChanges** | 模块图双向传播算法:children 全 declined→declined;任一 child accepted→accepted;与 Vite 模块图同源(`hmr/index.ts:134`) | 分析局部重载 | 决定 accepted/declined 的最终划分 |
| **loadDependencies** | 从某入口遍历 require.cache children 收集依赖(忽略 node_modules 与 ignored 集)(`hmr/index.ts:24`) | 同上 | 插件级检测:依赖含 accepted → 该插件重载 |
| **triggerLocalReload** | 局部重载事务入口:analyze→选插件→备份缓存→重 require→换插件→失败回滚(`hmr/index.ts:194`) | 同上 | 防抖后调用 |
| **rollback** | 恢复 require.cache 备份(必要时连同重装旧插件),保证失败时旧版本继续运行 | 同上 | 重载事务的保障机制 |
| **fullReload** | 进程级重启:`process.send({type:'shared', body})` + `process.exit(51)`(`loader/index.ts:167`) | 分析全量重启 | 守护进程(@koishijs/cli 的 `koishi start`)接收并重启 |
| **exitCode 51** | `Loader.exitCode = 51`,fullReload 的约定退出码 | 同上 | 守护进程据此区分"重启"与"崩溃退出" |
| **KOISHI_SHARED / envData** | 跨重启传递的环境数据(startTime / message),经 IPC → 环境变量注入新进程 | 分析"上号聊天"穿越重启 | `envData.message` 在 bot 上线后补发消息 |
| **hmr/reload 事件** | 局部重载执行前广播(reloads: Map<Plugin, Reload>),供其他插件(如 console)响应 | 读源码 | 事件名是 koishi 的公共 API 面 |
| **suspend** | Loader 标志:程序自己写配置时置 true,watcher 跳过该次变更,防自反馈死循环 | 分析配置热应用 | writeConfig 设置,watcher 消费 |
| **`~` 前缀** | 配置中表示"已禁用"的插件键名;控制台禁用插件时 `internal/fork` 事件触发 rename + 写回 | 读 createApp | 区别于删除条目 |
| **`$` 前缀** | 插件条目的元配置键:`$if`(条件挂载)、`$filter`(会话过滤) | 读 separate() | 与普通配置分离处理 |
| **writeConfig** | 原子写配置:临时文件 + rename;经 0ms 宏任务去重合并(`loader/shared.ts:251`) | 分析配置持久化 | silent 参数控制是否 emit('config') |
| **interpolate** | 配置插值:`${{ expr }}` 语法以 params.env(process.env)求值(`loader/shared.ts:277`) | 读 readConfig | 支持环境变量注入配置 |
| **esbuild-register** | Node require hook,运行时实时编译 .ts,使工作区插件源码免构建直跑(官方 dev 脚本 `-r esbuild-register`) | 追问"插件如何调试" | loader.import 的 require() 命中此 hook |
| **BuildFailure + code-frame** | esbuild 编译错误的类型;hmr 的 handleError 用 `@babel/code-frame` 渲染错误帧(文件:行:列+高亮)后 rollback | 读 error.ts | 调试体验:改错了旧版本继续运行 |
| **宿主应用(app / Context)** | 插件的运行底座:提供事件/服务/数据库/机器人连接;插件是导出 `apply(ctx)` 的库,不能独立运行 | 追问"没有 core 底座" | 官方模板项目 = 自带宿主的 workspace |
| **workspace 宿主模板** | `npm create koishi` 生成的 monorepo:外层是 koishi 应用(scripts.dev/start),`plugins/` 放本地插件以 `workspace:` 协议被依赖 | 澄清脚手架误解 | 调试开发的主流载体 |

## 3. 指称映射表(用户怎么说话 → 指什么)

| 用户以后说 | 实际指 | 别再用的模糊说法 |
| --- | --- | --- |
| "热更新 / 改代码生效" | 需先区分:局部重载(triggerLocalReload)/ 配置热应用(state.update)/ 全量重启(fullReload) | "刷新一下" |
| "插件重载" | registry.delete(旧) + loader.replace + 各 fork 用原 config 重新 plugin() | "插件重启" |
| "模块图分析" | analyzeChanges(accepted/declined 双向传播) | "依赖分析那个东西" |
| "本地插件" | 配置中相对路径键名(`./plugins/foo`,ns-require 直载)或 workspace:/file: 依赖 | "没发布的插件" |
| "模板项目" | npm create koishi 生成的 workspace 宿主应用(自带底座) | "脚手架项目"(歧义:也可能是纯插件包) |
| "ts 直跑" | esbuild-register 的 require hook 实时编译 | "自动编译" |
| "编译报错帧" | handleError + @babel/code-frame 渲染的 BuildFailure | "红色报错" |
| "守护进程" | `koishi start` 的外层进程:崩溃自动重启 + 接收 exit 51 | "父进程"(语义不全) |
| "重启后补发消息" | envData.message 机制(KOISHI_SHARED IPC) | "上号聊天的那个魔法" |
| "插件多开" | fork / ForkScope(同一插件多配置实例) | "多实例"(不指明是 fork) |
| "禁用插件" | `~` 前缀(internal/fork 事件 rename + writeConfig) | "注释掉插件" |
| "条件挂载" | `$if` 元配置 | "配置里的开关" |

## 4. L2 布局内部模块指称表(按源码文件挂靠)

### plugins/hmr/src/index.ts — Watcher 类内部

| 模块名 | 是什么 | 父子关系 |
| --- | --- | --- |
| watcher | chokidar FSWatcher 实例,监听 root 目录 | Watcher > watcher |
| base | 监听基准目录(baseDir + config.base) | Watcher > base |
| triggerLocalReload | 局部重载事务主体 | Watcher > triggerLocalReload > analyzeChanges |
| analyzeChanges | accepted/declined 传播算法 | Watcher > analyzeChanges |
| loadDependencies | 依赖收集工具函数(模块级) | 文件 > loadDependencies |
| backup / rollback | require.cache 备份与恢复 | triggerLocalReload > rollback |
| attempts | 重 require 后的新插件导出表 | triggerLocalReload > attempts |
| Reload | {filename, children: Map<ForkScope, string>} 结构 | triggerLocalReload 操作的数据单元 |

### packages/loader/src/shared.ts — Loader 类内部

| 模块名 | 是什么 | 父子关系 |
| --- | --- | --- |
| init / findConfig | 初始化:定位 koishi.config.{yaml,yml,json,js} | Loader > init > findConfig |
| readConfig | 读配置(yaml/json 走 fs+parse 不污染 require.cache;js 走 require) | Loader > readConfig |
| writeConfig / _writeConfig | 去重合并的原子写 | Loader > writeConfig |
| migrate / migrateEntry | 旧配置迁移(database 默认值、group key 重排) | Loader > migrate |
| forkPlugin | resolve 名字 → parent.plugin() | Loader > forkPlugin |
| reload / unload | 按配置 key 增删改插件(fork.update 或新建 fork) | Loader > reload;group.apply 递归调用 |
| store | WeakMap<any, string>:插件对象 → 配置名 | Loader > store |
| paths(scope) | 由 fork 树算配置路径(写回时定位) | Loader > paths |
| createApp | 启动主流程:new Context → group:entry → 挂 internal 事件 | Loader > createApp |
| kRecord | Symbol.for('koishi.loader.record'):scope 上的 fork 记录表 | 挂在各 scope 上 |

### packages/loader/src/index.ts — NodeLoader 内部

| 模块名 | 是什么 | 父子关系 |
| --- | --- | --- |
| scope | ns-require 实例(namespace:'koishi', prefix:'plugin', official:'koishijs', dirname:baseDir) | NodeLoader > scope |
| fullReload | process.send(shared) + exit(51) | NodeLoader > fullReload |
| localKeys | .env 注入的本地环境变量键(重读配置前清除) | NodeLoader > localKeys |

### cordis packages/core/src — registry(对照,注意版本)

| 模块名 | 是什么 | 父子关系 |
| --- | --- | --- |
| resolve(plugin) | 插件对象 → apply 函数(注册表键) | RegistryService > resolve |
| delete(plugin) | 删表 + 依次 fiber/scope dispose | RegistryService > delete |
| plugin(plugin, config) | 注册插件 + 创建 fiber(v4)/ fork(3.x) | RegistryService > plugin |

## 5. 未命名实体(待命名)

| 描述 | 出现位置 | 建议命名 |
| --- | --- | --- |
| 四层热能力栈(fullReload/HMR/配置热应用/Loader 的分层) | 本次对话总结 | hot-stack(四层热栈) |
| "插件是无底座的库,寄宿于宿主应用"这一关系模型 | 追问脚手架启动时澄清 | 宿主-插件寄宿模型 |
| "改错代码旧版本继续运行"的调试保障特性(rollback + code-frame 组合) | 分析重载事务时 | 失败安全重载(fail-safe reload) |
| koishi 稳定线(cordis 3.x / Scope 体系)与本地 cordis 仓库(v4 / Fiber 体系)的版本分叉 | 对照两仓库时发现 | cordis-v3-v4 分叉(提醒:学 HMR 以 koishi 主仓库为准) |
| 官方 dev 脚本组合(koishi start + esbuild-register + yml-register + NODE_ENV=development) | 搜索官方文档 | dev 启动配方 |

## 附:版本与环境注意

- koishi 主仓库依赖 `cordis@^3.18.1`(MainScope/ForkScope 体系);本地 `.claude/repo/cordis` 是 v4 dev(Fiber 体系),概念名有分叉(fiber ↔ scope),学习 HMR 以 koishi 主仓库源码为准。
- 守护进程代码(`@koishijs/cli` 的 `koishi start`)与官方模板仓库不在已克隆仓库中,其行为(崩溃重启、exit 51 接管)依据官方文档描述与 fullReload 的 IPC 协议推断。
