# koishi-init-model 概念阐述(2026-09-05 v1)

> **Topic:** plugin-dev-dx
> **类型:** project doc(模块概念阐述)
> **版本:** v1(首次产出)
> **分析对象:** `.claude/repo/koishi-boilerplate`(koishijs/boilerplate,`npm init koishi` 的模板源)
> **关联:** `compare_dev-dx-2026-09-05-v1-status.md`、`intent/workspace-base-2026-09-05-v1-design.md`

## 0. 原始问题(用户原话)

> koishi是如何实现这种模式的 生成文档,构建插件需要底座是一个正在讨论的东西 还没有确定,koishi不就是npm初始化插件 就自带底座吗

## 1. 整体框架

"koishi npm 初始化就自带底座"的机制实体是 **boilerplate 模板仓库** —— `npm init koishi` 产出的不是裸插件包,而是一个**自足的 yarn workspace 应用工程**:底座(koishi + 40 余个官方插件)在 `dependencies`,dev 工具链(esbuild-register/tsx/yakumo/koishi-scripts)在 `devDependencies`,新插件由 `npm run new` 脚手架进 `external/` 目录,`npm run dev` 用**项目内的** `koishi` CLI 启动。`yarn install` 一次之后,该工程与机器环境完全解耦。

```
boilerplate(npm init koishi 产物)
├── package.json      ← 底座(dependencies: koishi+全家桶) + dev工具链(devDeps)
│                        scripts: new/setup/clone(koishi-scripts) · dev/start(底座CLI)
├── koishi.yml        ← 应用配置(~40 插件清单,group 分组,$if 条件挂载)
├── tsconfig.json     ← paths 魔法: 'koishi-plugin-*' → external/*/src(源码级插件解析)
├── external/         ← npm run new 生成的新插件落点(不在模板里,setup 时创建)
├── docker/           ← 部署面(Dockerfile + lite 变体)
└── yakumo.yml        ← monorepo 构建系统(koishi 官方工具链)
```

## 2. L1 概念名称表

| 概念名 | 一句话定义 | 首次提出语境 | 与其他概念的关系 |
| --- | --- | --- | --- |
| **boilerplate** | koishijs 官方模板仓库,`npm init koishi` 的产物源(README:"本仓库包含了 Koishi 的模板项目") | 追问"npm 初始化插件就自带底座" | 是"底座自带"的载体;官方教程页 koishi.chat/manual/starter/boilerplate.html |
| **底座即 dependencies** | `koishi: ^4.18.11` 与 40+ 官方插件(console/market/sandbox/adapters…)是模板的**普通 dependencies**,非全局、非 npx | 读模板 package.json | 与 devDeps 的 dev 工具链(esbuild-register/tsx/yakumo)分离;`koishi` CLI bin 随包安装进项目 |
| **koishi-scripts** | devDep `@koishijs/scripts`,提供 `npm run new / setup / clone` 三个脚手架命令(scripts 字段直连) | 读模板 scripts | `new` 在 external/ 里生成新插件;`setup` 初始化;`clone` 克隆外部插件仓库进 workspace |
| **external/** | workspace 中"created plugins"的落点目录(tsconfig 注释原文:"The `external` directory is used to store created plugins") | 读 tsconfig paths 注释 | 被 workspaces globs(`external/*`、`external/*/external/*` 等 8 层嵌套)纳入;`clone` 的克隆目标 |
| **workspaces 多层 glob** | package.json 声明 `external/*`、`external/*/packages/*`、`external/koishi/plugins/*`、`plugins/*` 等 —— 可同时开发独立插件与从官方仓克隆的嵌套 monorepo 插件 | 读模板 package.json | 使 workspace 能吞下任意来源的插件工程 |
| **tsconfig paths 源码级映射** | `'koishi-plugin-*': ['external/*/src', 'packages/*/src', 'plugins/*/src']` —— 插件名直接解析到本地源码;前缀族(assets-/booru-/cache-)各有专属行 | 读模板 tsconfig.json | 开发中的插件被同 workspace 其他代码 import 时吃到 src 而非 node_modules 构建产物 |
| **dev 启动配方** | `cross-env NODE_ENV=development koishi start -r esbuild-register -r yml-register` | 读模板 scripts.dev | `koishi` bin 来自项目 dependencies;`-r` 双 hook 使 .ts 源码与 .yml 配置免构建直载 |
| **NODE_ENV=development** | dev 脚本注入的环境变量,影响插件行为(koishi 文档:dev 模式额外特性) | 同上 | 与 `-r` hooks 组成 dev 语义 |
| **类型同源** | 插件 `import { Context } from 'koishi'`,类型来自 node_modules 里的底座包 —— 类型与运行时同一来源 | 与 nx-pn 内联接口对照时提出 | 是"插件依赖底座"的形态之一(依赖的是类型/bin,不是运行时副本) |

## 3. 指称映射表(用户怎么说话 → 指什么)

| 用户以后说 | 实际指 | 别再用的模糊说法 |
| --- | --- | --- |
| "npm init 自带底座" | boilerplate 模板:底座在 dependencies + dev 工具链在 devDependencies | "脚手架送底座" |
| "koishi 的插件脚手架" | `npm run new`(koishi-scripts)在 external/ 生成插件 | "init 插件" |
| "源码级插件解析" | tsconfig paths 把 `koishi-plugin-*` 映射到 external/*/src | "本地包" |
| "dev 脚本配方" | koishi start + esbuild-register + yml-register + NODE_ENV | "那串命令" |
| "类型同源" | 插件 import 底座包获得 ctx 类型 | "有类型" |

## 4. L2 仓库内部模块指称表(挂靠 koishi-boilerplate)

### package.json

| 模块名 | 是什么 | 父子关系 |
| --- | --- | --- |
| dependencies(底座区) | koishi + @koishijs/plugin-*(console/market/sandbox/adapter-*/analytics…) 40+ 项 | package.json > dependencies |
| devDependencies(工具链区) | @koishijs/scripts、esbuild-register、tsx、yml-register、cross-env、yakumo 系、@koishijs/client | package.json > devDependencies |
| scripts.new/setup/clone | koishi-scripts 三命令的 npm 入口 | package.json > scripts |
| scripts.dev/start | dev 配方 / 生产启动(`koishi start`) | package.json > scripts |
| workspaces globs | 8 条 external 嵌套 + packages/* + plugins/* | package.json > workspaces |

### tsconfig.json

| 模块名 | 是什么 | 父子关系 |
| --- | --- | --- |
| paths 前缀族 | assets-/booru-/cache-/dialogue- 各自映射到 external/<族>/packages/*/src | tsconfig > compilerOptions.paths |
| paths 通配 | koishi-plugin-* → external/*/src 等 4 落点 | 同上 |

### koishi.yml

| 模块名 | 是什么 | 父子关系 |
| --- | --- | --- |
| group:server/basic/console | 插件按功能分组的配置段 | koishi.yml > plugins |
| `~` 前缀条目 | 默认禁用(admin/bind/auth/inspect…) | group 内条目 |
| `$if: env.KOISHI_AGENT…` | 按运行环境条件挂载(android/desktop 插件) | 条目级元配置 |

### docker/

| 模块名 | 是什么 |
| --- | --- |
| Dockerfile / Dockerfile.lite | 完整版与精简版部署镜像 |
| setup.sh / entrypoint.sh | 容器内初始化与入口 |

## 5. 未命名实体(待命名)

| 描述 | 出现位置 | 建议命名 |
| --- | --- | --- |
| "底座随模板以普通依赖交付,dev 完全项目内自足"这一模式 | 本次讨论 | template-bundles-base(模板捆绑底座) |
| nx-pn 模板用内联结构接口替代底座类型依赖的做法 | 对照发现 | inline-structural-ctx(见 §6) |
| workspace 吞下外部 monorepo 克隆的能力(8 层 glob) | boilerplate workspaces | nested-workspace-ingest |

## 6. 与 nx-pn 的对应物对照(现状快照,取舍未决)

| 层 | koishi boilerplate | nx-pn 0.3.3 现状 |
| --- | --- | --- |
| 底座交付 | 模板 dependencies 携带 koishi+全家桶 | 脚手架 package.json **零 @flowot 依赖**;底座为环境级(workspace-base 稿候改) |
| 插件类型来源 | `import { Context } from 'koishi'` —— 类型同源,底座演进类型同步 | **内联结构接口 HostCtx**(模板与 example-api 的 host.ts 均自带 "Structural view of the plugin ctx" 局部 interface),构建零平台依赖,但底座 ctx 演进时接口漂移不报错(运行时才暴露) |
| 插件产物 | yakumo 构建的 npm 包(不含底座) | zip(不含底座;esbuild external cordis/react,已验证) |
| 新插件生成 | `npm run new` → external/(workspace 内多插件共宿主) | `npx @flowot/nx-pn init <name>` → 独立目录(每插件一工程) |
| dev 启动 | 项目内 koishi CLI + 双 `-r` hook 免构建 | dev.mjs 探测/拉起环境底座 + build-zip 上传 |
| 一宿主多插件 | boilerplate workspace 天然形态(new 进 external/) | 上传到同一在线宿主(端口/共享策略为 workspace-base 未决分叉) |

**讨论状态记录**:用户判定"构建插件需要底座与否"尚未确定 —— 当前并存两种现状:koishi 路线(插件吃底座包的类型,依赖换同步)与 nx-pn 路线(内联结构类型,零依赖换漂移风险)。该取舍是 `workspace-base` 稿实施时的伴生决策点。

## 7. 证据索引

| 事实 | 位置 |
| --- | --- |
| 模板定位(官方模板仓库) | `koishi-boilerplate/README.md` |
| 底座即 dependencies(koishi ^4.18.11 + 40 插件) | `koishi-boilerplate/package.json` dependencies |
| dev 工具链 devDeps(esbuild-register/tsx/yakumo/koishi-scripts) | 同上 devDependencies |
| dev 启动配方 | 同上 scripts.dev |
| koishi-scripts 三命令 | 同上 scripts.new/setup/clone |
| 8 层 workspaces glob | 同上 workspaces |
| external/ 注释原文 + paths 映射 | `koishi-boilerplate/tsconfig.json` |
| koishi.yml 分组/~/$if | `koishi-boilerplate/koishi.yml` |
| nx-pn 内联 HostCtx("Structural view of the plugin ctx") | `nx-pn/apps/cli/templates/plugin-basic/host.ts`、`plugins/example-api/host.ts:23` |
| nx-pn 构建 external cordis/react(产物零底座) | `nx-pn/packages/host/src/plugins/host-compiler.ts:46`、模板 build-zip.mjs:34,46 |
