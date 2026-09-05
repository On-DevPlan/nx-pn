# dev-dx-master-plan — 插件开发体验总体架构(koishi 对齐 + 双分发通道)

> **Date:** 2026-09-05
> **Topic:** plugin-dev-dx
> **类型:** intent doc(预测设计 · 2c · master plan)
> **版本:** v1(首次产出;整合 `workspace-base` / `shared-install-base` / `base-version-negotiation` 三稿 spirit + 用户新增两需求)
> **状态:** 试验(总体方向已与用户对齐,phase 分解与拍板项待逐 phase 收敛)
> **核心问题:** 将 nx-pn 插件开发体验重构为 koishi 对齐形态 —— 插件脚手架内嵌底座、构建产物与底座零耦合、workspace 支持指定宿主底座上多插件同时开发与热更新 —— 同时保留 npm 与 zip 两条分发通道(zip 作为非 npm 场景的暂时性插件市场替代),并明确底层大范围重构的影响面与 phase 路径。

## 原始请求(用户原话)

> OK 我现在确定了 我决定走 插件底座嵌入插件脚手架 支持快速启动, 然后构建可以分离,插件也支持指定运行的底座 进行热部署开发 ,npm可以上传 就说明本质是支持的 我也需要支持zip的上传 用于暂时取代插件市场 , 进行底层的大范围重构 查考koishi的插件架构体验,特别是run dev带有底座,build就是纯插件的设计模式,以及指定宿主底座 多插件同时开发在一个底座上的体验

## 轻微重写版(仅修错别字与口癖)

> OK,我现在确定了:我决定走"插件底座嵌入插件脚手架,支持快速启动"的路线;然后"构建可分离,插件也支持指定运行的底座进行热部署开发"。npm 既然可以上传,就说明本质是支持的;我也需要支持 zip 上传,用于暂时取代插件市场。进行底层的大范围重构。参考 koishi 的插件架构体验,特别是:`npm run dev` 带有底座 + `build` 就是纯插件 的设计模式,以及"指定宿主底座,多插件同时开发在一个底座上"的体验。

## 本版要验证的假设

**按 koishi 模板同构改造 nx-pn(脚手架内嵌底座 + 三层依赖 + peer 发布 + workspace 多插件 + HMR)后**,可以在不大改 host/client/web 协议面的前提下,消灭三痛点(时间不可控 / 版本漂移 / 命令行代理不专业),且能多插件同时开发在一底座上、保留 zip 作为非 npm 分发通道 —— 总改动面限于 init 模板、loader/通道入口、CLI 命令面、web UI 的 plugin 面板;host 与 client 不推翻。

## 一、设计原则

| # | 原则                       | 体现                                                                                                                                                   |
| - | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | 底座嵌入插件脚手架         | `init` 生成 workspace(类似 koishi boilerplate),底座在 devDeps;`npm install` 一次全装                                                               |
| 2 | 构建与运行时分离           | koishi 三层依赖模型:`peerDependencies` 发布态声明底座 / `devDependencies` 开发态内嵌底座 / `dependencies` 插件自有依赖。**产物零底座字节** |
| 3 | 指定宿主底座多插件同时开发 | workspace 多`plugins/` 子目录或 external/ 风格,统一宿主进程共享;`npm run dev` 启动宿主、加载所有 plugins/ 子目录                                   |
| 4 | 快速启动 + 零 npx          | dev 走`node ./node_modules/@flowot/nx-pn/bin/nx-pn.mjs` 直调,无 npx 代理                                                                             |
| 5 | 热部署开发                 | 移植 koishi hmr 思想(模块图 + rollback)到 nx-pn:host 半源码直载场景;zip 通道维持当前整包重传热替换                                                     |
| 6 | npm 与 zip 双分发通道      | npm 通道(registry/file:/tgz)继续 + zip 上传作为**非 npm 场景的暂时性替代**(用户在 npm 生态成熟前的过渡通道,或企业内部分发场景)                   |
| 7 | 渐进重构                   | 已发布 0.3.3 不破坏;新增能力(add / link / workspace dev)在增量路径上落地                                                                               |

## 二、模块拆分(总体架构图)

```
plugin-myplugin/                                  ← init 生成的 workspace(替代当前 8 文件脚手架)
├── package.json                                    devDeps: @flowot/nx-pn(底座) + esbuild/tsx
│                                                  peerDeps(npm 通道发布时声明): @flowot/nx-pn-host
├── plugins/                                       workspace 多插件:一个目录 = 一个开发中插件
│   ├── plugin-a/
│   │   ├── host.ts     (直接 import {HostCtx} from '@flowot/nx-pn-client' —— 类型同源)
│   │   └── browser.tsx
│   └── plugin-b/ …
├── koishi.config.yml(命名沿用 + nx-pn 风格)     宿主配置:端口、profile、插件路径列表
├── tsconfig.json      paths: '@flowot/plugin-*' → plugins/<name>/src
└── scripts/
    ├── dev.mjs                  启动 workspace 底座(项目内 lockfile 锁定)+ 加载 plugins/
    └── build.mjs                单插件独立构建 → dist/<id>.zip(npm publish 兼容 npm 包格式)
```

对应底层 nx-pn 仓库改造面:

```
packages/host/           ← 大范围重构主战场
├── src/plugins/
│   ├── loader.ts           + loadFromWorkspace(plugins/ 批量加载) + loadFromLink(link: dir)
│   └── installer.ts        + 三层依赖校验 + peer 版本协商
├── src/server/
│   ├── plugin-route.ts     + POST /plugins/:id/start(0.3.3 已加)+ peer 协商端点
│   └── workspace-route.ts  ← 新:workspace 批量管理(列/启/停/重载 plugins/*)
└── src/

packages/client/         + 类型同源 SDK:'@flowot/nx-pn-client' 导出 HostCtx 等类型(模板 plugin 直接 import)
apps/cli/                ← init.ts 大改:从 8 文件脚手架 → workspace 模板
├── src/init.ts            (重写) 模板变量 + 多插件创建子命令
└── templates/plugin-basic/  ← 替换为 plugin-workspace 模板(workspace 结构)

plugins/                  nx-pn 自家插件随 master plan 升级结构(可选)
```

不动:`packages/core` 纯契约 / `packages/host` 的 audit/REST/WS 协议面 / client 协议面 / web shell 路由 / cordis shim。

## 三、数据流(关键场景)

### 场景 1 · 单插件开发(workspace 模式)

```
nx-pn init my-plugin            → 生成 plugin-myplugin/ workspace 模板
                                含 koishi.config.yml + plugins/<id>/host.ts+browser.tsx
npm install                      → 底座随 devDep 装入 node_modules
npm run dev                      → dev.mjs:node ./node_modules/@flowot/nx-pn/bin/nx-pn.mjs
                                → 宿主读取 koishi.config.yml → plugins: ['./plugins/my-plugin']
                                → loader.loadFromWorkspace(plugins/) 批量挂载
                                → HMR watch 启动(模块图监听)
修改 plugins/my-plugin/host.ts   → HMR 触发 → registry.delete + 重新 load → 无重启
build                            → scripts/build.mjs → dist/my-plugin.zip(产物 peer 声明 + 零底座)
```

### 场景 2 · 指定宿主底座多插件同时开发

```
plugin-myplugin/workspace 已起 host-A(底座版本 v1,端口 4560)
plugin-other/workspace 想附加到同一 host-A:
  cd plugin-other && npm run dev -- --attach  http://localhost:4560 --workspace my-plugin
  → dev.mjs probe ok → 不拉起新 host,直接 attach 现有 host
  → loader 走 link: 或 file: 路径把 plugin-other 加入 host-A 的 plugins/ 列表
  → 多个 workspace 共享同一 host,各自独立 HMR(基于 link 文件 watch)
```

或更 koishi 化:一个 workspace 容纳多个 plugins/ 子目录,统一 host 加载 —— 单 workspace 多插件模式(koishi external/ 风格)。

### 场景 3 · 双通道分发

```
# npm 通道(npm 生态)
nx-pn plugin add @scope/my-plugin          → installer.installBySpec → npm install(走 peer 检查)
                                           → 自动激活(installed-state 对账)
# zip 通道(暂时取代插件市场 / 企业内部分发)
nx-pn plugin upload ./dist/my-plugin.zip   → REST POST /api/plugins multipart
                                           → loader.load + dedup + browser-half WS push
                                           → 该通道作为非 npm 场景的过渡 / 临时替代
```

### 场景 4 · 热部署开发(HMR)

```
host 半(workspace 内 src/ 直载):koishi 风格模块图 reload + rollback —— 移植自 @koishijs/plugin-hmr
browser 半(workspace 内):Vite HMR 或 esbuild watch + WS 重推浏览器半
zip 通道(发布场景):保留 0.3.3 已建的整包重传热替换语义
```

## 四、关键决策(融合三稿 + 新需求)

| # | 决策                    | 结论                                                                                                                              | 出处                     |
| - | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1 | 总路线                  | **koishi 对齐**(workspace + devDep 内嵌底座 + peer 发布)                                                                    | 用户拍板                 |
| 2 | 构建可分离              | koishi 三层依赖模型(peer/devDep/deps);`@flowot/nx-pn-client` 导类型供插件 import                                                | koishi-init-model v2 §2 |
| 3 | 多插件同时开发          | workspace 多 plugins/ 子目录(koishi external/ 风格);并支持跨 workspace attach 到同一 host(适配 nx-pn 现有 REST 通道)              | 用户新增需求             |
| 4 | 快速启动                | `node ./node_modules/@flowot/nx-pn/bin/nx-pn.mjs` 直调;删 dev.mjs npx 缓存分支                                                  | workspace-base 稿        |
| 5 | 分发通道                | npm + zip**双通道并存**(zip 作为非 npm 场景的暂时性替代);不废弃 zip                                                         | 用户新增需求             |
| 6 | 版本协商                | **npm 通道优先用 peer 机制**(原生);**zip 通道继续用 manifest.minHost 提案**(base-version-negotiation 稿);不重复造轮子 | koishi peer 洞察         |
| 7 | 是否走 dsh peers 回退链 | **否**(koishi 路线 + workspace 已满足用户需求;dsh 路线在混合版也无必要 —— 详 §四#8 shared-install-base v1)               | shared-install-base 稿   |
| 8 | 底层大范围重构          | 见 §七/八                                                                                                                        | 用户新增需求             |

## 五、接口 / 代码骨架(高层)

```ts
// 模板 package.json(workspace 模式)
{
  "name": "plugin-myplugin",
  "private": true,
  "devDependencies": { "@flowot/nx-pn": "^0.4.0", "esbuild": "^0.24.0", "typescript": "5.6.3" },
  "scripts": { "dev": "node scripts/dev.mjs", "build": "node scripts/build.mjs" }
}
// 单插件 package.json(plugin-<id>/>/package.json)
{
  "name": "@my-scope/plugin-<id>",
  "peerDependencies": { "@flowot/nx-pn-host": "^0.4.0" },
  "devDependencies": { "@flowot/nx-pn-client": "^0.4.0" }
  // dependencies: 插件自有依赖
}
// tsconfig.paths(workspace 根)
"@flowot/plugin-*": ["plugins/*/src"]   // 插件名→本地源码
```

```ts
// host/loader.ts 新增(loadFromWorkspace + link 加载的入口)
class PluginLoader {
  async loadFromWorkspace(dir: string): Promise<LoadResult[]> { /* 扫 plugins/*/package.json → 批量 load */ }
  async loadFromLink(targetDir: string): Promise<LoadResult> { /* 解析 link:/file: 路径 + peer 检查 */ }
  async start(pluginRunId: string): Promise<LoadResult> { /* 0.3.3 已加,从 zipPath 重载 */ }
}
```

```ts
// client/host-api.ts:导出 HostCtx 等类型(插件类型同源)
export interface HostCtx { logger, on, auditClient, pluginStorage, hostCall, ... }
```

## 六、职责边界

| 关注点          | 负责                                   | 不负责                                         |
| --------------- | -------------------------------------- | ---------------------------------------------- |
| 模板生成        | apps/cli/init.ts(workspace 模板)       | 不决定具体插件内容                             |
| 底座供给        | 模板 devDeps + workspace 锁版          | 不管生产部署(由 base-version-negotiation 衔接) |
| 多插件加载      | host/loader.ts loadFromWorkspace       | 单插件生命周期仍由 lifecycle 管                |
| npm 分发        | host/installer.ts installBySpec        | 走 npm peer,不自造协商层                       |
| zip 分发        | host/plugin-route.ts POST /api/plugins | 仅作非 npm 替代,功能不增                       |
| 热更新(host 半) | 新增 HMR(从 koishi 移植)               | 不覆盖 zip 通道已有整包热替换                  |
| 类型            | client/@flowot/nx-pn-client 导出       | core 仍为纯契约,不动                           |

## 七、改动范围(底层大范围重构的影响面)

| 层级     | 模块                                     | 现状                           | 改后                                                                            | 影响等级     |
| -------- | ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- | ------------ |
| 模板     | apps/cli/templates/plugin-basic/         | 8 文件单插件包                 | → 替换为 workspace 模板(koishi.config.yml + plugins/ + scripts/)               | **大** |
| 脚手架   | apps/cli/src/init.ts                     | 写 8 文件                      | → 重写:生成 workspace、注入 {{workspaceId}}、多插件子命令 init-plugin          | **大** |
| 加载     | packages/host/src/plugins/loader.ts      | 仅 zip 加载                    | + loadFromWorkspace(扫 plugins/)+ loadFromLink(link:/file:)+ 三层依赖校验       | **大** |
| 安装     | packages/host/src/plugins/installer.ts   | npm 通道已有                   | + peer 依赖检查(npm install 走原生);保留 ledger                                 | 中           |
| 协议     | packages/host/src/server/plugin-route.ts | REST 上传/install/start/remove | 保留并验证 zip 路径上的 peer 协商(若 zip 内 peer 与 host peer 冲突)             | 中           |
| 类型     | packages/client/src/                     | 仅 client 内部类型             | + 导出 HostCtx 等核心类型供插件直接 import                                      | **小** |
| web UI   | apps/web/src/pages/PluginsPage.tsx       | 加载事件面板 + start/stop      | + workspace 视图(子目录列表)、attach 模式提示                                   | 中           |
| HMR      | packages/host/src/                       | 无                             | + 新增 @flowot/nx-pn-hmr(移植自 koishi plugin-hmr 思想,适配 workspace 源码直载) | **大** |
| 进程模型 | host 启动流程                            | 当前单 process                 | 保持单 process(workspace 共享同一 host)                                         | 无           |

**未触动**:packages/core / host 的 audit/REST/WS 协议面 / client 协议面 / web shell 路由 / cordis shim —— 保护产品内核的不被推翻。

## 八、迁移 / 实施路径(底层大范围重构的 phase 分解)

1. **Phase 1 · 模板重构**(无破坏)

   - apps/cli/templates/plugin-basic/ → plugin-workspace 模板(koishi.config.yml + plugins/<id></id>/ + scripts/dev.mjs + scripts/build.mjs)
   - apps/cli/src/init.ts 重写为 workspace 生成
   - 验收:新 init 生成的项目结构、npm install + npm run dev 可启动
2. **Phase 2 · 类型同源 SDK 暴露**(无破坏)

   - packages/client/src 增 HostCtx/HostCallCtx 等类型 export(改名 `@flowot/nx-pn-client/types`)
   - 验收:插件 host.ts 直接 `import type { HostCtx } from '@flowot/nx-pn-client'` 通过编译
3. **Phase 3 · npm 通道 peer 校验 + link/file: 支持**(中等破坏)

   - host/installer.ts npm install 走原生 peer 检查;新增 loadFromLink
   - 验收:`npm install file:./plugins/foo` 后插件即时激活;peer 版本冲突 npm 警告
4. **Phase 4 · workspace 多插件加载 + dev.mjs 快速启动**(中等破坏)

   - host/loader.ts loadFromWorkspace;dev.mjs 直调项目内底座
   - 验收:workspace plugins/ 下两个插件同时被加载;新 init 项目 npm run dev 全程零网络
5. **Phase 5 · HMR 移植**(大破坏)

   - 新增 @flowot/nx-pn-hmr(koishi plugin-hmr 思想适配);workspace 源码直载场景下的模块图 reload
   - 验收:修改 plugins/<id></id>/host.ts → 秒级热生效;ts 编译失败 rollback 旧版本继续运行
6. **Phase 6 · 跨 workspace attach(可选) + zip 通道 peer 协商验证**(小破坏)

   - dev.mjs --attach 模式(connect 已有 host + 加载 workspace plugin)
   - zip 通道在 manifest 含 peer 声明时验证与 host 的 peer 版本匹配
7. **Phase 7 · 文档与生态同步**

   - .claude/skills/api-audit/references 更新(plugin-contract / cli-automation 等)
   - 0.3.4 → 0.4.0 发版模板变更(随 cli 包)

## 九、验收标准(总体级)

| # | 验证项                    | 方法                                                                                    |
| - | ------------------------- | --------------------------------------------------------------------------------------- |
| 1 | 脚手架内嵌底座            | 新 init 项目 → npm install → lockfile 含 @flowot/nx-pn → npm run dev 全程零 npx      |
| 2 | 类型同源                  | 插件 host.ts 直接`import type { HostCtx } from '@flowot/nx-pn-client'` → 编译通过    |
| 3 | 三层依赖                  | 产物 zip/npm 包 peer 声明 @flowot/nx-pn-host;devDeps 不进产物;dependencies 仅有插件自有 |
| 4 | 多插件同时开发            | workspace plugins/ 下 plugin-a + plugin-b → npm run dev 同时加载;各自独立 HMR          |
| 5 | 跨 workspace attach(可选) | workspace A 启动 host → workspace B dev --attach 接进去                                |
| 6 | zip 通道不废弃            | 旧上传 REST 仍工作;新场景下 zip 作为非 npm 场景的暂时替代                               |
| 7 | npm peer 原生协商         | npm install @flowot/scope-plugin:peer 冲突时 npm 警告                                   |
| 8 | 不破产品内核              | 审计/REST/WS 协议面无破坏性变更                                                         |

## 十、待用户拍板的决策

| # | 决策                                                    | 推荐                                                                      |
| - | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1 | workspace 多 plugins/ 风格 vs 一个 workspace = 一个插件 | **多 plugins/ 子目录**(koishi 模式;多插件同时开发更顺)              |
| 2 | 跨 workspace attach 是否进 v1                           | **否**(Phase 6 可选;先聚焦 workspace 内多插件)                      |
| 3 | HMR 移植范围(仅 host 半 vs +browser 半 Vite HMR)        | 先 host 半(browser 半 zip 通道的 WS 推送已工作)                           |
| 4 | workspace 多插件的协议层表示                            | 共享同一 host → 一份 snapshot + 一份 plugins 列表;多 instance/realm 不引 |
| 5 | 0.3.4 vs 0.4.0 发版策略                                 | **0.4.0**(底层重构 + 三层依赖 + workspace 是新纪元,语义匹配)        |

## 十一、参考

- `intent/workspace-base-2026-09-05-v1-design.md`(koishi 路线,作为 master plan 的子模块被吸收)
- `intent/base-version-negotiation-2026-09-05-v1-design.md`(zip 通道 peer 协商;npm 通道走原生 peer,本稿 §四#6 收敛之)
- `intent/shared-install-base-2026-09-05-v1-design.md`(dsh 路线,§四#7 明确不采纳)
- `project/koishi-init-model-2026-09-05-v2-concepts.md`(三层依赖 + peer 洞察 + dev-embed/publish-decouple 双态模式)
- `project/compare_dsh-base-supply-2026-09-05-v1-status.md`(dsh 专项对比,peer 路径与 install 锚点的对照参考)
- koishi 源码实证:`koishi/plugins/hmr/package.json`、`koishi/plugins/common/echo/package.json`、`koishi-boilerplate/package.json`、`koishi/yakumo.yml`
