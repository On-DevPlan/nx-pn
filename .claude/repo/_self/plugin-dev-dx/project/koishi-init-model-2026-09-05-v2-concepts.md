# koishi-init-model 概念阐述(2026-09-05 v2)

> **Topic:** plugin-dev-dx
> **类型:** project doc(模块概念阐述)
> **版本:** v2(相对 v1:新增 §2 三层依赖模型、peer-协商层、koishi 字段三个概念;§6 新增双半区包格式对照与 peer 协商对照;其余 v1 概念保留并沿用其证据)
> **分析对象:** `.claude/repo/koishi`(官方插件包实证)、`.claude/repo/koishi-boilerplate`(模板)、nx-pn 0.3.3 对照
> **关联:** v1 同名文档、`intent/base-version-negotiation-2026-09-05-v1-design.md`

## 0. 原始问题(用户原话,v2 增量部分)

> koishi是如何实现这种模式的 生成文档,构建插件需要底座是一个正在讨论的东西 还没有确定,koishi不就是npm初始化插件 就自带底座吗

> koishi实现了开发内嵌入底座,构建打包作为单独插件的模式吗?

## 1. 整体框架

**"npm init 自带底座 + 发布独立插件"是 koishi 的同一个模式的两个态**:开发态由 boilerplate workspace 内嵌底座(devDependencies + 项目内 CLI),发布态由插件包的三层依赖声明把底座"还回去"(peerDependencies)—— 产物是零底座字节的独立 npm 包。构建管线(yakumo: tsc → esbuild)负责两态之间的转换。

```
开发态(内嵌底座)                 构建管线                    发布态(独立插件包)
─────────────────────          ─────────────              ─────────────────────
boilerplate workspace            yakumo build               @koishijs/plugin-hmr
 └ devDeps: koishi(类型+运行) ──▶  tsc → lib/  ──▶          ├ peerDeps: koishi(宿主必须提供)
 └ koishi CLI(项目内 bin)         esbuild → dist/(browser)   ├ devDeps: koishi(仅开发机器,不入产物)
 └ external/ 里开发插件                                       ├ dependencies: chokidar(自有)
                                                             └ files: [lib, src](零底座字节)
```

## 2. L1 概念名称表(v2 新增概念加 ★;v1 概念见同名 v1 文档,不再重复)

| 概念名 | 一句话定义 | 首次提出语境 | 与其他概念的关系 |
| --- | --- | --- | --- |
| ★ **三层依赖模型** | koishi 插件包把依赖分三层:`peerDependencies`=底座(发布态协商,不捆绑)/ `devDependencies`=底座副本(开发态类型+运行,不入产物)/ `dependencies`=插件自有依赖 | 追问"开发内嵌底座、构建打包独立插件是否实现" | 是该模式的核心机制;实证:`koishi/plugins/hmr/package.json` |
| ★ **peerDependencies(发布态底座声明)** | 插件包向安装方声明"宿主必须提供 koishi ^4.18.11"—— npm 原生在版本不满足时告警 | 读 hmr package.json | 与 devDep 副本互补:peer 管发布协商,devDep 管开发自足 |
| ★ **devDependencies(开发态底座内嵌)** | 同一个 koishi 包同时出现在 devDeps —— 类型同源(`import { Context } from 'koishi'`)+ boilerplate/monorepo 内本地运行 | 同上 | devDeps 不进发布产物,npm 语义天然完成"开发内嵌/发布剥离"切换 |
| ★ **koishi 字段(插件 manifest)** | 插件 package.json 内的 `koishi: { browser, category, description, locales }` 声明块 —— koishi 生态的插件元数据入口 | 读 echo package.json | 与 nx-pn 的 `api-audit.manifest` 字段同角色(§6) |
| ★ **peer-协商层** | npm 的 peer 机制本身就是"插件声明底座需求 + 宿主提供 + 版本不满足告警"的原生协商层 | 对照三家底座供给模型时提出 | koishi 用 peer 声明;dsh 用 `autoInstallPeers: false`+回退链消费单份;nx-pn zip 通道不经 npm 故需自造(manifest.minHost 提案) |

## 3. 指称映射表(v2 增量)

| 用户以后说 | 实际指 | 别再用的模糊说法 |
| --- | --- | --- |
| "三层依赖" | peer(底座协商)/ devDep(开发内嵌)/ deps(自有) | "依赖分离" |
| "发布态剥离" | 底座在 peerDeps+devDeps,产物 files 只含 lib/src | "打包不带底座"(未指明机制) |
| "peer 协商" | npm peerDependencies 的版本满足性告警 | "npm 检查版本" |
| "koishi 字段" | 插件 package.json 的 `koishi: { browser… }` manifest 块 | "那个配置字段" |

## 4. L2 仓库内部模块指称表(v2 增量,挂靠 koishi 插件包 package.json)

| 模块名 | 是什么 | 实证 |
| --- | --- | --- |
| peerDependencies 区 | 底座版本协商声明(koishi、@koishijs/loader) | `koishi/plugins/hmr/package.json` |
| devDependencies 区 | 底座开发副本(koishi)+ 构建工具(esbuild)+ 类型补丁 | 同上;echo 另有 @koishijs/plugin-mock |
| dependencies 区 | 插件自有运行依赖(chokidar、@babel/code-frame) | 同上 |
| koishi 字段 | `browser: true`(声明含浏览器半)/ category / description(多语言)/ locales | `koishi/plugins/common/echo/package.json` |
| main/typings/files | `lib/index.js` / `lib/index.d.ts` / `["lib","src"]` —— 产物零底座 | hmr、echo 皆同 |

## 5. 未命名实体(v2 增量)

| 描述 | 出现位置 | 建议命名 |
| --- | --- | --- |
| "dev 内嵌 + peer 剥离 + 构建管线转换"的双态模式整体 | 本轮讨论 | dev-embed-publish-decouple(开发内嵌/发布解耦双态) |
| nx-pn zip 通道自造的 peer 等价物 | base-version-negotiation 稿 | 已命名 minHost(协议即 peer 重建) |

## 6. 与 nx-pn 的对应物对照(v2 修订)

### 6.1 双半区包格式对照(新)

| | koishi console 插件(npm 包) | nx-pn 插件 |
| --- | --- | --- |
| manifest | package.json `koishi` 字段(browser/category/…) | zip 内 `manifest.json`;npm 通道 package.json `api-audit.manifest` 字段 —— **与 koishi 字段同构** |
| host 半产物 | `lib/`(tsc) | zip 内 host.js(esbuild, external cordis) |
| browser 半产物 | `dist/`(yakumo-esbuild,当 `koishi.browser: true`) | zip 内 browser.js(esbuild, external react 系) |
| 分发协议 | npm registry | npm 通道(registry)/ zip 通道(HTTP multipart) |

### 6.2 版本协商机制对照(新)

| | koishi | dsh | nx-pn 现状 |
| --- | --- | --- | --- |
| 协商载体 | npm peerDependencies(原生告警) | `autoInstallPeers: false` + 单实例回退(结构性免协商) | 无;zip 通道提案 manifest.minHost(base-version-negotiation 稿)—— 即"在 zip 通道重建 peer 语义" |
| npm 通道 | — | — | 插件包若声明 peer 于 `@flowot/nx-pn-host`,npm 生态原生提供协商(现状:脚手架零 @flowot 依赖,未声明) |

### 6.3 v1 对照表保留项

v1 §6(底座交付/插件类型来源/产物/生成/启动/一宿主多插件六行对照)继续有效,其中"插件类型来源"行新增实证:echo 源码 `import { Context, h, Schema } from 'koishi'`(`plugins/common/echo/src/index.ts:1`)—— 类型同源的直接代码证据。

## 7. 证据索引(v2 增量)

| 事实 | 位置 |
| --- | --- |
| 三层依赖实证(peer: koishi+@koishijs/loader;devDep: koishi+esbuild;deps: chokidar+@babel/code-frame) | `koishi/plugins/hmr/package.json` |
| echo 的 koishi 字段(browser: true/category/locales)+ peer 含 koishi | `koishi/plugins/common/echo/package.json` |
| 类型同源源码(直接 import koishi) | `koishi/plugins/common/echo/src/index.ts:1` |
| 构建管线(tsc → esbuild) | `koishi/yakumo.yml` pipeline.build |
| nx-pn npm 通道 manifest 字段(api-audit.manifest) | `nx-pn/packages/host/src/plugins/installer.ts`(buildManifestFromPkg) |
| nx-pn 产物零底座(external cordis/react) | v1 §7 沿用 |

## 8. 未覆盖/待延伸(v2 修订)

- **console 客户端半的运行时 serve 机制未实证**:本轮仅实证了 `koishi.browser: true` 字段与 yakumo esbuild 产物;"console 运行时从插件包加载 dist/" 的具体机制(@koishijs/plugin-console / client 侧加载器)在已克隆仓库中无对应源码,属推断 —— 对照 nx-pn browser-half WS 推送时应标注此差距
- koishi-scripts `new` 生成的插件骨架是否预置三层依赖声明(boilerplate 的 external/ 为空目录,模板本体在 @koishijs/scripts 包,未克隆)
