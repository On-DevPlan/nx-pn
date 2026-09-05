# Intent: nx-pn 插件开发体验改造 — 方向确立(koishi × dsh 借鉴)

> **Date:** 2026-09-05
> **Topic:** plugin-dev-dx
> **类型:** intent doc(常规意图 · 2a)
> **状态:** 方向已与用户对齐,待开设计稿
> **前置材料:** `../project/compare_dev-dx-2026-09-05-v1-status.md`(三方比较)

## 原始请求(用户原话,按时间顺序)

> 比较koishi和deepseekharness 如何实现插件开发者 直接就能启动底座 支持插件热更新 当前nx-pn的插件开发者比较麻烦 ,底座要更新,koishi如何做到无感插件run dev

> koishi  dsh 哪个更适合我的场景呀 类似于统一的网络管理层,页面作为插件

## 背景与动机

nx-pn 0.3.3 已具备 dev.mjs 热循环(watch → build-zip → 热上传 → runId dedup 替换)与三级底座探测(全局 nx-pn / npx 缓存 / NX_PN_HOST_CMD),但与 koishi/dsh 对比后暴露结构性差距:

1. **底座是"环境级"的**:插件脚手架 package.json 零 @flowot 依赖,插件项目与底座版本无锁定关系;底座升级是独立手动动作(2026-09-05 实录:npmmirror 镜像滞后 → ETARGET;底座新能力对旧底座上的插件项目不可见)。
2. **dev 循环必含构建+上传**:每次变更跑 esbuild bundle → zip → HTTP 上传,koishi 是 require hook 直吃源码、保存即达。
3. koishi 的"无感 run dev"三支柱(底座进项目 workspace / esbuild-register 源码直载 / 进程内插件级 HMR + rollback)在 nx-pn 均无对应物。

同时三方对比确认:**"统一网络管理层 + 页面作为插件"的产品组合是 nx-pn 独有内核**(auditClient 归因审计 + browser-half WS 免刷新热推,后者为三家唯一),不应被 koishi/dsh 的整体模型替换。

## 目标

• 插件开发者 `init`/clone 后**一条命令**进入可用开发环境,底座自动就位且版本确定
• 插件源码修改**秒级热生效**,对齐 koishi "无感" 体验(理想态:无构建步骤)
• 底座版本与插件项目**锁定或协商**,升级不漂移、不受镜像/缓存滞后干扰
• **保留 nx-pn 产品内核**:双半区插件形态、auditClient 统一网络层、browser-half 免刷新热推、长驻宿主模型

## 约束与边界

• 插件发布通道(zip 上传 / npm install)保持不变 —— dev 机制可与发布通道分离(dev 走源码直载、发布走产物,允许双轨)
• 长驻宿主架构不动(页面热推、审计管道依赖它)
• cordis shim / 现有 REST+WS 协议面渐进扩展,不推翻
• 已发布的 0.3.3 dev.mjs 热循环是增量起点,不是要删除的重构对象

## 关键决策

| 决策点                       | 结论                                                                           | 理由                                                                |
| ---------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 是否整体迁移到 koishi 或 dsh | **否**                                                                   | 产品内核(网络层管控+页面插件化)两家都没有;迁移=丢失差异化           |
| dev 循环机制参照系           | **koishi**(底座进 workspace / require hook 源码直载 / 插件级 HMR)        | 三方对比中 dev DX 最优;"底座要更新"痛点在 koishi 模型下结构性不存在 |
| 底座分发与组合参照系         | **dsh**(自洽单 CLI + cordis.patch.yml overlay 激活,底座升级不动用户配置) | 直接对应底座升级/版本漂移痛点;行级 id 寻址的声明式组合可借鉴        |
| 产品架构(网络层/页面插件)    | **维持 nx-pn 自有模型**                                                  | 对比确认这是独有优势,不是负债                                       |
| 技术同源性                   | 三家同属 cordis 生态(dsh vendor cordis,koishi 即 cordis 旗舰应用)              | 机制迁移无 paradigm 转换成本                                        |

## 待定问题

1. **源码直载 vs 保留构建上传**:dev 通道如何做到"无构建"?esbuild-register/tsx 挂在宿主侧还是 dev 脚本侧?双半区里 browser.tsx 如何在不打包的情况下进宿主(现在的 WS 推送以 zip 内编译产物为前提)?
2. **底座进项目的形态**:workspace devDep 锁定 + 项目内启动脚本(koishi 式),还是 dsh 式单 CLI + profile overlay?或两者混合(项目内锁定版本、全局实例可复用)?
3. **现有 dev.mjs 三级探测的归宿**:全局/npx 缓存路径保留为兜底还是退场?
4. **版本协商**:插件项目如何声明"最低底座版本",dev 启动/宿主加载时如何校验与提示?
5. **HMR 粒度**:整包替换已够用,还是引入 koishi 式模块图分析(accepted/declined 传播)做插件内局部热更?失败 rollback 语义如何映射到 runId dedup?

## 下一步

以上待定问题各自可开 design 稿(2c)推进,候选 design-name:

- `workspace-base` — 底座进插件项目的锁定与启动形态
- `source-direct-dev` — dev 通道源码直载(宿主侧 require hook / browser-half 直载)
- `base-version-negotiation` — 版本声明与校验协议
