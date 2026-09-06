# nx-pn init vs koishi init — 插件初始化对比(2026-09-06 v1)

> **Topic:** plugin-dev-dx
> **类型:** project doc(比较文档 · 现状快照)
> **版本:** v1(首次产出)
> **对比对象:** nx-pn 0.3.3+(master plan v2 落地后)↔ koishi 4.18(boilerplate + @koishijs/scripts)

## 0. 原始问题(用户原话)

> 现在插件init提供哪些指令 和koishi插件初始化进行对比 ,是否支持快速构建成纯插件形式 生成文档

## 1. 一句话结论

**nx-pn init 已支持快速构建纯插件形式**(workspace → build → dist/<id>.zip 零底座字节),但与 koishi 相比缺一个"在已有 workspace 内追加新插件"的子命令(koishi 的 `npm run new`)。

## 2. 指令面对照

### 2.1 初始化

| 维度 | koishi | nx-pn 现状 |
|---|---|---|
| 初始化命令 | `npm init koishi` → 下载 boilerplate workspace | `npx @flowot/nx-pn init <name> --dir <path> [--force]` → 生成 workspace 模板 |
| 产物结构 | workspace 根 + `external/`(空,后续 `npm run new` 填充)+ 40+ 官方插件 deps | workspace 根(9 文件)+ `plugins/<id>/`(5 文件,立即可开发) |
| 底座位置 | `dependencies`(koishi + 全家桶) | `devDependencies`(@flowot/nx-pn) |
| help 文字 | N/A(交互式 create-koishi) | `init <name> [--dir <path>] [--force]`(注:help 里仍写"8 template files"——已过时,实际 9 文件) |

### 2.2 开发循环

| 维度 | koishi | nx-pn 现状 |
|---|---|---|
| 启动底座 | `npm run dev` = `koishi start -r esbuild-register` | `npm run dev` = `node scripts/dev.mjs`(probe :4560 → 冷启动拉起 `node ./node_modules/@flowot/nx-pn/bin/nx-pn.mjs --data-dir .data`) |
| 底座归属 | workspace 内(项目自带) | workspace 内(devDep + node_modules symlink/file:) |
| TS 处理 | esbuild-register require hook(免构建直载) | esbuild 编译到 zip 再 loadFromLink(有构建步骤) |
| 热更新 | @koishijs/plugin-hmr(模块图分析) | 无 HMR;改码 → re-run `npm run build` + restart |

### 2.3 构建纯插件

| 维度 | koishi | nx-pn 现状 |
|---|---|---|
| 构建命令 | `npm run build` = `yakumo build`(tsc + esbuild) | `npm run build` = `node scripts/build.mjs <id>`(esbuild bundle) |
| 产物 | `lib/`(node 半)+ `dist/`(browser 半)→ npm 包 | `dist/<id>.zip`(manifest + host.js + browser.js)→ 零底座字节 ✓ |
| npm 发布 | 直接 `npm publish`(peerDeps 声明底座) | zip 可直接上传到运行中的 host;npm 发布需手动(有 package.json + peerDeps) |
| 上传到运行宿主 | 无此概念(npm install / market) | `nx-pn add file:./dist/<id>.zip --port <n>` 或 `curl -F zip=@... POST /api/plugins` |
| **纯插件形态** | ✅ npm 包(三层依赖:peer/dev/own) | ✅ zip(manifest + 双半区编译产物;package.json 带 peerDeps) |

### 2.4 追加新插件到已有 workspace

| 维度 | koishi | nx-pn 现状 |
|---|---|---|
| 命令 | `npm run new`(koishi-scripts new)在 external/ 里生成新插件骨架 | **无对应命令** —— init 只在首次创建 workspace;追加需手动复制 plugins/<id>/ 模板 |
| 多插件共宿主 | workspace 天然支持(external/ 里 N 个) | workspace 支持(koishi.config.yml 列 N 个 plugins/ 子目录)—— 已验证 |

## 3. 纯插件构建验证(2026-09-06 实测)

```
cd /tmp/combined-nxpn
npm run build
  → dist/enco.zip (5813 bytes)
      manifest.json  187 bytes
      host.js       1707 bytes   ← esbuild bundle, external cordis
      browser.js    3609 bytes   ← esbuild bundle, external react
  → 零底座字节 ✓

nx-pn add file:./dist/enco.zip --port 4560
  → ✔ 已上传插件 enco (v0.3.3), run=run-133
```

## 4. 差距清单(nx-pn → koishi 对齐度)

| # | 差距 | 影响 | 建议 |
|---|---|---|---|
| 1 | **无"追加新插件"子命令** | 只能 init 一次;多插件需手动复制模板 | 新增 `nx-pn init-plugin <id> --dir <workspace>` 或 `nx-pn plugin-new <id>` |
| 2 | **help 文字过时**("8 template files") | 误导(实际 9 文件 workspace) | 修正 help 字符串 |
| 3 | **无 HMR** | 改码需 rebuild + restart(koishi 秒级热更) | Phase 5 HMR 移植(master plan deferred) |
| 4 | **TS 免构建直载未实现** | koishi 用 esbuild-register 直载 .ts;nx-pn 走完整 build | 可引入 tsx/esbuild-register 到 dev.mjs |
| 5 | **npm publish 流程未自动化** | koishi 的 yakumo 处理 monorepo 发布;nx-pn 手动 | 可加 `nx-pn publish` 子命令 |

## 5. nx-pn 独有优势(koishi 没有)

| # | 能力 | 说明 |
|---|---|---|
| 1 | **zip 上传到运行中宿主** | `POST /api/plugins` multipart —— 任何 HTTP 客户端可远程部署 |
| 2 | **浏览器半区 WS 免刷新热推** | 上传后 `browser-half.load` WS frame 推送到所有连接的浏览器 |
| 3 | **auditClient 统一网络层** | 所有插件 IO 经审计 + 归因(koishi 插件自由 fetch) |
| 4 | **stop/start/remove 运行时 API** | REST 端点管理插件生命周期(koishi 走配置文件) |

## 6. 快速参考

```bash
# nx-pn 完整开发循环
npx @flowot/nx-pn init my-plugin --dir ./my-workspace
cd my-workspace
npm install                    # 安装底座(devDeps)
npm run dev                    # 启动内嵌底座 + 加载插件
# ... 编辑 plugins/my-plugin/host.ts ...
npm run build                  # → dist/my-plugin.zip(纯插件)
npx @flowot/nx-pn add file:./dist/my-plugin.zip --port 4560  # 部署到运行中的宿主

# koishi 对照
npm init koishi                # 生成 boilerplate workspace
cd my-bot
npm run new                    # 在 external/ 追加新插件
npm run dev                    # 启动底座 + HMR
npm run build                  # yakumo 构建(npm 包)
npm publish                    # 发布到 npm
```

## 7. 证据索引

| 事实 | 位置 |
|---|---|
| nx-pn init help(9 文件 workspace) | `apps/cli/src/main.ts` --help 输出 |
| workspace 模板(9 文件) | `apps/cli/templates/plugin-workspace/` |
| dev.mjs 自启动 | `apps/cli/templates/plugin-workspace/scripts/dev.mjs`(2026-09-06 修复 __root 路径) |
| build.mjs 纯插件产物 | `apps/cli/templates/plugin-workspace/scripts/build.mjs`(esbuild external cordis/react) |
| zip 上传端点 | `packages/host/src/server/upload-route.ts` |
| koishi boilerplate 结构 | `.claude/repo/koishi-boilerplate/package.json`(dependencies 含 koishi+40 插件) |
| koishi npm run new | `.claude/repo/koishi-boilerplate/package.json` scripts.new = "koishi-scripts new" |
| koishi 三层依赖实证 | `koishi/plugins/hmr/package.json`(peerDeps: koishi; devDeps: koishi; deps: chokidar) |
