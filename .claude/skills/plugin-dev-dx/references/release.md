# 发布（作者循环收尾）与 GitHub Actions 现状

## 插件作者循环（脚手架 README 定义的发布路径）

```bash
cd <插件目录>
npm install
npm run build                 # tsc + esbuild + STORED zip，含 externals 断言
npm publish                   # 发布到 npm
```

用户侧安装：

```bash
npx @flowot/nx-pn add <name>         # npm 路径（写 ledger，下次 host 启动重放）
# 或热装（live host）：
curl -F "zip=@dist/<id>.zip" http://localhost:4560/api/plugins
# 或
POST /api/plugins/install {"spec":"file:<abs-path>"}
```

- `main`/`exports` 指向 package 根 `./host.js`（`resolveHostEntry` 解析 pkg.main → npm install 路径可用）
- build 产物同时落 package 根（host.js/browser.js/manifest.json）与 `dist/<id>.zip`
- 发布前跑 `npm run build` 的断言：host.js 保持 `cordis` external；browser.js 保持 react/react-router-dom external（regex 检查，防双 React）

## 版本管理

- monorepo `@flowot/nx-pn*` 全家桶**统一版本**（apps/cli、packages/host、client、web、storage-* 一起 bump）
- npm publish workflow 有 `Verify uniform family version` 步骤（设计如此，见脚手架文档）
- 示例版本轨迹：0.3.1（npm latest）→ 0.3.2（monorepo，storage 包 bump 提交）

## GitHub Actions 现状（2026-09 探查）

**两个仓库当前都没有 `.github/workflows/`**：

- `nx-pn`（平台 monorepo）：无 workflows 目录；`package.json` scripts 有 build/test/lint/check:spec/start/dev，但无 CI 或 publish workflow 落地
- `go-ac`（含 pn-embedding 插件）：无 workflows 目录；插件发布目前是本地 `npm publish`

### 规划（未实施，待用户确认）

1. **平台 release workflow**（nx-pn）：`workflow_dispatch`（手动触发，带版本号输入）或 tag 触发（`v*`）→ `pnpm install && pnpm build && pnpm test` → 统一 bump 全家桶版本 → `npm publish`（需 NPM_TOKEN secret）→ 打 tag + GitHub Release
2. **插件发布 workflow**（每个插件仓库可选）：push tag 或 dispatch → `npm run build` → 产物上传为 Release asset → `npm publish`（如需）

### 发布"全新版本"的快捷路径（当前可用）

```bash
# 平台：monorepo 内统一 bump（手动）
# 改 apps/cli、packages/*、apps/web 的 version → 0.4.0
# 然后：
cd <nx-pn repo>
pnpm build && pnpm test
git add -A && git commit -m "release: v0.4.0"
git tag v0.4.0 && git push origin master --tags
npm publish -w ...            # 或配置 CI 后由 action 发布
```

注意：npm 发布需要账号权限（`npm whoami` + 对应包的 publish 权限）；未配置前 GitHub Action 无法自动发布。
