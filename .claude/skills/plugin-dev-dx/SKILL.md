---
name: plugin-dev-dx
description: nx-pn 平台插件开发者体验与闭环工作流。当用户开发/维护/调试 nx-pn 插件（@flowot/nx-pn、api-audit 生态，如 pn-embedding）、需要理解或改进 npm run dev 热更新循环、启动/拉起/升级底座（host/web）、排查插件热部署失败、评估插件开发 DX（对比 koishi / deepseek-harness）、或执行 init→dev→验证→发布完整作者循环时使用。触发词：插件开发、npm run dev、热更新/热部署、底座启动/升级、plugin dev、dev.mjs、热上传、插件闭环。
---

# 插件开发者体验闭环（Plugin Dev DX）

nx-pn 的插件开发模型：**一条 `npm run dev` 命令打通"改代码 → 自动热部署 → 页面自动切换"**，底座常驻、无需重启、无需手动刷新。本 skill 存储当前实现现状与验证过的事实，目的是提升插件开发者的体验与闭环能力、快速稳定启动、以及及时跟上底座更新。

## 现状速览

| 项 | 现状 |
|---|---|
| 脚手架 | `npx @flowot/nx-pn init <name>` → 9 个文件（含 `scripts/dev.mjs`） |
| 一条命令闭环 | `npm run dev`：watch 源文件 → 自动 rebuild → 自动热上传 → 页面自动推送 |
| 底座启动 | 三级探测自动拉起（NX_PN_HOST_CMD → 全局 nx-pn → npx 缓存），无弹窗、秒级失败指引 |
| 热更新链路 | 上传 → host 解压/校验/esbuild → runId 去重替换 → WS 推 `browser-half.load` → 页面自动切换 |
| 数据目录 | 默认 `~/.api-audit`；`--data-dir <path>` 可隔离（测试/多实例） |

## 核心工作流：npm run dev

```bash
cd <插件目录>            # 例如 web/pn-embedding
npm run dev             # 连接 :4560 或自动拉起底座 → watch → 每次保存自动热部署
npm run dev -- --port 4561
npm run dev -- --data-dir C:\tmp\dev
```

启动后行为：

1. `probeHost()` 探测 `--port`（默认 4560）上的 `/api/plugins`——已有底座则直接连接
2. 无底座 → 按三级探测拉起（见 "快速稳定启动"）
3. 执行一次 startup 构建 + 上传（`run=run-N`）
4. 进入 watch：保存 `host.ts` / `browser.tsx` / `src/**` / `package.json`（`.ts/.tsx/.json`，防抖 400ms）→ 重建 zip → 热上传 → 打印 `✓ run=run-N replaced=["run-N-1"]` → 已打开页面自动切换新 browser 半

机制细节、参数、失败恢复与实测输出示例：读 `references/dev-loop.md`。

## 快速稳定启动

底座（host/web，一个 Node 进程同时扛 HTTP/WS/cordis/持久化）有三种启动方式，按推荐序：

```bash
npx @flowot/nx-pn                          # 官方 CLI，默认 :4560（npm latest 0.3.x）
node <monorepo>/apps/cli/bin/nx-pn.mjs     # monorepo dev（先 pnpm build）
npm i -g @flowot/nx-pn && nx-pn            # 全局装一次，之后秒起（dsh 模型）
```

`npm run dev` 的自动拉起按此顺序探测（全部 sub-second，无静默 npx 下载、无弹窗）：

1. 环境变量 `NX_PN_HOST_CMD`（用户自定义启动命令，自带 --port/--data-dir）
2. PATH 里的全局 `nx-pn`（`npm i -g @flowot/nx-pn` 一次安装，之后自动拉起秒级）
3. npx 缓存完整（`npx --no-install @flowot/nx-pn --version` 探测通过）
4. 都没有 → **立即打印指引**（不再卡 25s 等下载），dev 继续 watch，底座就绪后保存文件自动续传

所有 spawn 均 `windowsHide: true`（Windows 不弹新 cmd 窗口）。拉起后轮询 30s 等待就绪。

细节：读 `references/host-bootstrap.md`。

## 及时更新底座

底座升级（npm 版 / monorepo 版）流程与插件兼容要点、`--data-dir` 隔离测试、重启后插件重放语义（npm ledger `restartNpmPlugins` + zip 重放 `restartFromDataDir`）：读 `references/host-bootstrap.md` 的「底座升级」节。

## 平台关键机制（必须先知道的坑）

验证过的事实，违反任一条都会出现"构建通过但运行炸"：

1. **shell 渲染注册组件时不传 props**（`<Component />`）→ 视图只能闭包捕获 `ctx`（`withTopNav` 显式 `<View ctx={ctx}/>`）；依赖 `props.ctx` 必炸 `Cannot read properties of undefined (reading 'hostCall')`
2. **调用形状是 `ctx.hostCall.hostCall('<plugin>/<action>', payload)`**（cordis service 方法），不是 `ctx.hostCall(...)`；browser 半需 `(fn).inject=['pages','auditClient','hostCall']`
3. **manifest.json `routes[]` 不带 `title`**（validateManifest 只接受 `{path}`）；manifest.json 由 build 生成（init 不脚手架），源在 package.json 的 `api-audit.*`
4. **fullscreen 每个 route 组件自包含**（自带 TopBar），路由切换会卸载视图 → 跨视图状态用模块级 store（闭包 + subscribe hook）
5. **WS 冷加载竞态**：页面首次加载时 WS 未就绪，bootstrap 一次失败就跳登录 → 必须自动重试（实测 1200ms 间隔直到成功）
6. **接口字段假设要核对真实返回**：GSAC `/embedding/page` 的 chunk 无 `text/model/distance`（有 `title/strategy/chunkIndex`）；`/embedding/:id/chunks` 返回 `{list:[...]}`；大数 id 要 `String(id)` 防精度丢失
7. 双 Router（`<BrowserRouter>` 套壳）是破坏性反模式，不可用；browser 半必须 `export default`；react/react-router-dom 必须 external（import map 共享）

完整清单与排障：读 `references/platform-gotchas.md`。

## 发布（作者循环收尾）

脚手架自带发布路径：`npm run build`（含 externals 断言）→ `npm publish` → 用户 `npx @flowot/nx-pn add <name>` 或 zip 上传。插件/平台发布与 GitHub Actions 现状与规划：读 `references/release.md`。

## 决策参考

- 插件开发者对标 koishi（`yarn dev` 本地依赖直接跑）与 deepseek-harness（`npm i -g` 装一次、`dsh web` 秒起）：nx-pn 的 `npm run dev` + 全局 nx-pn 三级探测正是两者的组合模型。对比细节见 `.claude/repo/_self/koishi-hot-reload/` 与 `cli-automation/` 文档。
- 架构图与热更新链路图：见本会话早期输出的 renderer（上传 → `browser-half.load` 三泳道图）。
