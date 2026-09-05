# shared-install-base — nx-pn 全面转向 dsh 式安装实例共享模型

> **Date:** 2026-09-05
> **Topic:** plugin-dev-dx
> **类型:** intent doc(预测设计 · 2c)
> **版本:** v1(首次产出;与 `workspace-base-2026-09-05-v1-design.md`(koishi 路线)并行对比)
> **状态:** 试验(方向探索稿 —— 核心分叉"激进/混合"未拍板)
> **核心问题:** 把 nx-pn 的插件供给从"上传产物给环境级底座"整体改为 dsh 式"安装实例单份共享"(profile 目录 + pnpm link + peers 回退),能换来什么、要付出什么 —— 以及激进版与混合版哪个成立。

## 原始请求(用户原话,按时间顺序)

> 如果我完全扩展nx-pn为dsh模式   有什么优势和tradeoff 除了实现复杂

> dsh不能支持上传zip?

## 轻微重写版(仅修错别字与口癖)

> 如果我把 nx-pn 完全扩展为 dsh 模式,有什么优势和 tradeoff?除了实现复杂之外。

> dsh 不能支持上传 zip 吗?

## 本版要验证的假设

**nx-pn 已有的 npm 通道(install-by-name + ledger + restartNpmPlugins)是 dsh 模型的 60% 骨架 —— 把它补齐为完整 dsh 形态(profile 目录 / link 活链 / peers 回退 / reconcile 对账)后,能在不牺牲 browser-half 免刷新热推与协议级上传能力的前提下,结构性消灭底座供给三痛点**;而"激进版"(zip 通道废弃)不成立,损失大于收益。

## 一、模型原则(dsh 形态映射到 nx-pn)

| # | 原则 | dsh 源码对应 | nx-pn 映射 |
| - | --- | --- | --- |
| 1 | 安装实例即底座,锚点定死 | `INSTALL_ANCHOR`(profile-boot.ts:75) | 宿主进程 = 底座,dev 零拉取 |
| 2 | 插件安装 = 包管理动作 | `dsh plugin` = pnpm 薄转发(plugin.ts:120-160) | `nx-pn plugin add .` 语义 |
| 3 | 平台 SDK 单份共享 | peers 符号链回退(profile.ts:177-187) | 全插件消费同一 @flowot/nx-pn-client/cordis |
| 4 | 装了即激活 | installed-state 对账 + `dsh.bundle` 声明(plugin.ts:60-92) | manifest `api-audit` 声明探测 |
| 5 | 底座升级不动用户层 | patch 行 id 寻址 + overlay 叠层 | profile 配置层与底座版本解耦 |

## 二、结构性优势(相对现状与 koishi 路线)

| # | 优势 | 说明 |
| - | --- | --- |
| 1 | 底座供给问题**结构性消灭**(非工具缓解) | 装一次、锚点定死、dev 零网络;无 workspace-base 场景 3 的"项目副本 vs 在线实例"冲突(单份实例不存在第二份) |
| 2 | 插件生命周期回归 npm 语义,生态能力免费 | link/copy/git/tarball/alias/lockfile/`pnpm update` 全部白得;激活语义与包管理同构 |
| 3 | host 半零构建 dev 通道 | link 活链 + 宿主侧 require hook → host.ts 源码直载(koishi 三支柱之二顺手到手) |
| 4 | 升级路径清晰 | 底座任意升级不碰 profile 配置(patch id 寻址) |

## 三、Tradeoffs(除实现复杂度外,按严重度)

| # | Tradeoff | 细节 |
| - | --- | --- |
| ① | **双半区断裂 —— 产品内核一半不受益(最大代价)** | dsh 的 link 是宿主文件系统的事;browser.tsx→esbuild→WS 免刷新热推在 dsh 模型无对应物。浏览器不消费 node_modules 符号链 → 双轨或新协议 |
| ② | 一周内的热部署资产语义重定义 | 0.3.3 刚发布:REST 热上传/runId dedup/`/:runId/start`/`plugin.changed` 事件流/调试面板 —— 全建立在"插件=运行时上传产物"上;dsh 生命周期是"boot 组合+包管理事件" |
| ③ | 远程/多机通道边缘化(已源码证实) | dsh **无任何插件上传 HTTP 端点**(web-app bundle 全查无 upload/multipart;安装永远是宿主机本地 CLI 动作)。Web UI 拖装、CI 部署、跨机推送是 nx-pn 独有协议能力,激进版下萎缩 |
| ④ | 包管理器绑定 | dsh 要求 pnpm on PATH(ENOENT→127,Windows 需 shell:true);nx-pn 宿主目前零包管理器依赖 |
| ⑤ | Windows 符号链维护面 | reparse point/module proxy/heal 修复,dsh 为此写了百余行防御;主开发环境即 Windows |
| ⑥ | 版本协商只收敛不消灭 | 底座=安装实例 → 新能力仍需升级实例;`base-version-negotiation` 稿在此模型下依然必要(dsh 自身也未解决) |
| ⑦ | 插件校验关卡弱化 | zip 通道有 manifest schema+尺寸上限+ns storage 域的入口关卡;link 本地包=任意代码直入宿主,约束只剩 package.json 声明 |

## 四、zip/tgz 能力澄清(源码证实,修正认知)

| 通道 | nx-pn | dsh |
| --- | --- | --- |
| 协议层上传(HTTP POST 到运行宿主) | ✅ zip multipart | ❌ 无此概念(全仓无插件安装 HTTP 面) |
| 本地压缩包安装 | ✅ npm spec | ✅ **tgz only** —— `dsh plugin add ./foo.tgz` 走 pnpm tarball spec,reconcile 注释明示支持(plugin.ts:49);zip 不认 |
| 本地目录链接 | ✅ `file:./` | ✅ `link:` 活链 |

含义:dsh 不是"不能装压缩包",是**把安装做成本地包管理动作而非协议动作** —— tradeoff ③ 因此成立且更清晰。对称事实:nx-pn 的 zip 是自家约定(宿主手写 zip reader,loader.ts readZip),换 tgz 无技术障碍;zip 的存在意义是 Windows 人肉拖拽友好。

## 五、核心分叉(待拍板的主决策)

| 分叉 | 形态 | 得 | 失 |
| --- | --- | --- | --- |
| **激进版** | npm/link 成为唯一通道,zip 废弃 | 模型纯净,无双轨维护 | tradeoff ①②③ 全额承担;产品差异化(免刷新热推/协议上传)降级 |
| **混合版** | npm 通道升级为 dsh 形态(host 半源码直载);zip 通道保留为 browser 半+远程部署专用 | ①③ 缓解;现有资产保留;dev 体验对齐 koishi | 双轨长期并存,两套激活语义(reconcile + runId dedup)需文档化 |

**结构事实**:混合版的 npm 通道侧,现有 `npmInstallPlugin`+`pluginsDomain ledger`+`restartNpmPlugins` 已是 60% 骨架,缺 profile 目录/link 活链/peers 回退/reconcile 四块。

## 六、改动范围(混合版视角)

| 模块 | 现状 | 改后 |
| --- | --- | --- |
| npm 通道(installer.ts) | install-by-name 装进 plugins-registry | + profile 目录($NX_PN_HOME/profiles/)+ pnpm 转发命令 + reconcile |
| 平台 SDK 解析 | 插件 zip 内 bundle | + peers 符号链回退到宿主安装实例(新增 profile/node_modules heal 逻辑) |
| CLI | add/uninstall | + `nx-pn plugin <pnpm args>` 转发族 |
| zip 通道 | 主通道 | 保留,定位收窄为 browser 半+远程 |
| dev.mjs | build-zip+上传 | host 半可切源码直载(宿主侧 hook);browser 半维持构建 |

(改动清单为方向级;逐文件拆解待分叉拍板后展开)

## 七、验收标准(方向验证级)

| # | 验证项 | 方法 |
| - | ------ | ---- |
| 1 | 60% 骨架判断成立 | 以现 npm 通道跑通 `install file:./` + ledger 重启重放,列出与 dsh 四缺块的差距清单 |
| 2 | host 半源码直载可行 | 宿主挂 tsx/esbuild-register 后 `link:` 插件的 host.ts 免构建加载 |
| 3 | 混合版双轨不互踩 | 同一插件 id 经 npm 通道与 zip 通道先后安装,runId/ledger/页面注册表状态一致 |

## 八、待用户拍板的决策

| # | 决策 | 推荐 |
| - | ---- | ---- |
| 1 | 激进 vs 混合 | **混合**(激进版牺牲产品内核,收益可由混合版获得) |
| 2 | 与 workspace-base(koishi 路线)的关系 | 两者可叠加:项目锁定底座(koishi)+ 单实例共享(dsh)不互斥 —— 待专题对比后定 |
| 3 | peers 回退是否引入(Windows 符号链代价) | 混合版下可选;若仅 host 半源码直载,最小实现可不带回退链 |
| 4 | zip→tgz 是否顺带统一 | 不动(zip 服务于人肉拖拽场景;包管理通道天然 tgz) |

## 九、参考

- `../../project/compare_dsh-base-supply-2026-09-05-v1-status.md`(§3.2 链接方式行被本文 §四 精化:tgz spec 支持为 reconcile 注释明示)
- `workspace-base-2026-09-05-v1-design.md`(并行路线;其场景 3 冲突在单实例模型下不存在)
- `base-version-negotiation-2026-09-05-v1-design.md`(tradeoff ⑥:本模型下依然必要)
- dsh 源码:`apps/cli/src/plugin.ts:49`(tarball spec 对账)、`packages/bundle/web-app/src/index.ts`(无上传面,全文核验)
