# 底座（host/web）启动、自动拉起与升级

## 底座是什么

一个 Node 进程同时承担：HTTP 服务（:4560，含 `POST /api/plugins` 热上传、`POST /api/plugins/install`、静态服务 web/dist）+ WS（browser-half 推送、tool.invoke RPC）+ cordis 插件运行时 + 持久化（data-dir）。核心组装见 `packages/host/src/index.ts`（startHost）。

## 三种启动方式（按推荐序）

```bash
# 1) 官方 CLI（npm latest）
npx @flowot/nx-pn                    # 默认 :4560，自动开浏览器
npx @flowot/nx-pn --no-open          # 不开浏览器

# 2) monorepo dev（开发平台本身）
cd <nx-pn repo>
pnpm build                           # 全量编译（apps/cli + packages/*）
node apps/cli/bin/nx-pn.mjs          # 或 npm run dev / start

# 3) 全局安装一次（dsh 模型，插件开发者推荐）
npm i -g @flowot/nx-pn
nx-pn --no-open
```

常用参数（CLI）：`--port <n>`（默认 4560）、`--data-dir <path>`（默认 `~/.api-audit`）、`--no-open`。

## dev.mjs 的自动拉起（三级探测）

`npm run dev` 探测不到底座时按序尝试（全部 sub-second 探测，**不静默下载**）：

1. `NX_PN_HOST_CMD`（env）——直接 spawn 该命令，用户自带 --port/--data-dir
2. PATH 上的 `nx-pn`（全局装过）——`spawn('nx-pn', ['--no-open','--port',port, ...dataDir])`
3. npx 缓存完整——`npx --no-install @flowot/nx-pn --version` 通过 → `spawn('npx', ['--yes','@flowot/nx-pn', ...])` 复用缓存（无下载）
4. 都没有 → 打印三条指引（`npm i -g @flowot/nx-pn` / 手动 npx / 设 NX_PN_HOST_CMD），dev 继续 watch，底座就绪后保存文件自动续传

**关键实现点**：所有 spawn `windowsHide: true`（Windows 不弹新 cmd 窗口）；探测用 `spawnSync` + `stdio:'ignore'`（毫秒级）；拉起后 `waitForHost(30s)` 轮询 `/api/plugins` 直到 200。

**曾踩的坑（已修，勿回退）**：
- 旧版 `spawn('npx', ['--yes', ...])` 无条件触发 npx 下载：缓存残缺时 25s 超时 + 弹窗 + `fetch failed`。现在改为探测缓存、无缓存即快速指引
- 无 `windowsHide` 时 Windows 弹新 cmd 窗口

## 数据目录（--data-dir）

- 默认 `~/.api-audit`：`storage/<plugin-domain>/settings/*.json`（插件持久化）、`cache/compiled/*.mjs`（编译缓存）、`storage/plugins.json`（npm ledger）
- 多实例/测试：用 `--data-dir <temp>` 隔离（`npm run dev -- --data-dir <path>` 会自动透传给拉起的底座）
- **两个 host 共享同一 data-dir 会互相干扰**，测试时务必用独立目录

## 底座升级（及时更新新的底座）

### npm 版（插件开发者）

```bash
npm i -g @flowot/nx-pn@latest       # 升级全局底座
nx-pn --no-open                     # 新版本生效
```

验证新版本：`nx-pn --version`。dev.mjs 的自动拉起会直接用新全局版本。

### monorepo 版（平台开发者）

```bash
cd <nx-pn repo>
git pull                            # 拉到最新
pnpm install                        # 依赖变更
pnpm build                          # 全量编译（版本统一 bump：@flowot/nx-pn* 全家桶同版本）
node apps/cli/bin/nx-pn.mjs
```

### 重启后插件重放语义

- **npm 安装的插件**（`add <name>` / `add file:.`）：写 `storage/plugins.json` ledger + `plugins-registry/node_modules/<id>`，host 启动时 `restartNpmPlugins` 重放
- **zip 热上传的插件**：`restartFromDataDir` 从持久化的 zip 重放
- 所以重启底座不会丢插件；热更新（dev.mjs）期间无需重启

### 版本兼容注意

- 插件在 monorepo 0.3.2 底座上开发、npm latest 0.3.1 有差异时，以实际测试为准；hostCall bridge 需 ≥0.3.0
- 升级底座后若插件页面异常，先 `npm run build` 重编 + 热传一次（新底座可能改了 manifest 校验/注入契约）
