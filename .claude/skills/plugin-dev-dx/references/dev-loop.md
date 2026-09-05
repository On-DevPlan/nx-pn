# npm run dev 热更新循环（dev.mjs）机制细节

## 命令形态

```bash
npm run dev                                    # = node scripts/dev.mjs
npm run dev -- --port 4561                     # 指定底座端口（默认 4560）
npm run dev -- --data-dir C:\tmp\dev           # 指定数据目录（自动拉起底座时透传）
```

环境变量：

| 变量 | 作用 |
|---|---|
| `NX_PN_HOST_CMD` | 自定义底座启动命令（自带 --port/--data-dir），优先级最高 |
| （无） | 依次探测全局 nx-pn → npx 缓存 → 打印指引 |

## Watch 规则

- 根目录 `fs.watch(root, { recursive: true })`（Windows 支持 recursive）
- 命中：`*.ts / *.tsx / *.json`
- 跳过：`dist/`、`node_modules/`、`.git/`、根级 `host.js`、`browser.js`、`manifest.json`（构建产物）
- 防抖 400ms；**build 进行中的事件直接丢弃**（那是构建产物写入，避免自触发），所以每次真实保存恰好触发一次 cycle
- cycle 串行化：`building` 标志防重叠，build 期间收到的新事件标记 `pending`，当前 cycle 结束后续跑一次

## 一次 cycle 做什么

1. `build()`：`node scripts/build-zip.mjs`（tsc --noEmit 由 npm run dev 前的 build 保证？不——dev.mjs 直接跑 build-zip.mjs，不做类型检查；类型错误靠 build-zip 的 esbuild 报错暴露）
2. `upload()`：`FormData` multipart `POST http://localhost:<port>/api/plugins`，60s 超时
3. 打印 `[dev] ✓ run=<pluginRunId> replaced=[...] (Nms) — 页面已自动推送，无需刷新`
4. 失败：打印 `✗ <原因>`；`ECONNREFUSED/fetch failed` → 提示"底座不在线，保存文件自动续传"；其余 → "修复后保存任意源文件即可重试"

## 热更新链路（为什么页面不用刷新）

```
保存源码 → build-zip（esbuild 双 entry：host.ts→host.js、browser.tsx→browser.js，STORED zip）
  → POST /api/plugins（multipart zip）
  → host: 落盘 → validateManifest → esbuild 编 host 半到 cache/compiled/<hash>.mjs
  → 按 manifest.id 去重：lifecycle.remove(旧 run) + 广播 browser-half.retract
  → 注册新 fiber（新 pluginRunId）→ fiber.await
  → WS 推 browser-half.load 帧给所有已连接页面
  → 页面 shell 用新 blob URL 替换旧 browser 半 → UI 自动切换（无刷新）
```

- `pluginRunId` 单调递增（run-37 → run-40 → …）；`replaced` 列出被替换的旧 run
- 插件持久化数据（pluginStorage/settings）保留——热替换不丢存储
- 编译缓存 `~/.api-audit/cache/compiled/<id>-<hash>.mjs`，相同 hash 不重复编译

## 实测输出样例（pn-embedding，2026-09）

```
[dev] watching D:\code\a_go\leaning\gs-ac\web\pn-embedding
[dev] upload target: http://localhost:4560/api/plugins (Ctrl+C to exit)

[dev] 已连接运行中的 web（:4560）
[dev] startup
pn-embedding: built ...\dist\pn-embedding.zip (59715 bytes)
  zip[manifest.json]: 1103 bytes
  zip[host.js]: 8340 bytes
  zip[browser.js]: 49962 bytes
[dev] ✓ run=run-45 replaced=["run-44"] (2776ms) — 页面已自动推送，无需刷新

[dev] change: src/api.ts            ← 保存文件
[dev] ✓ run=run-46 replaced=["run-45"] (237ms)
```

## 失败模式与恢复

| 现象 | 原因 | 处理 |
|---|---|---|
| `✗ upload failed (HTTP 4xx, ...)` | manifest 校验失败（如 routes 带 title）/ 已存在同名冲突 | 修 manifest/package.json 的 api-audit.*，保存重试 |
| `✗ fetch failed` | 底座不在线 | 启动底座（或 `npm i -g @flowot/nx-pn` 后自动拉起），保存即续传 |
| 页面无变化 | 浏览器 half 未自动切换 | 确认 WS 连接；硬刷新一次（stale blob URL 场景） |
| build 报 esbuild 错误 | 源码语法/import 错 | 修复后保存 |

## 与 npm run build 的关系

`npm run build` = `tsc --noEmit && node scripts/build-zip.mjs`（一次性，含类型检查 + 产物落 package 根供 npm install 路径）。
`npm run dev` 直接跑 build-zip.mjs（watch 循环），不跑 tsc；类型问题由编辑器/esbuild 暴露。
