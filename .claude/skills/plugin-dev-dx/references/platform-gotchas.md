# 平台契约与踩坑清单（全部实测验证）

违反任一条的表现通常是"构建通过、运行报错"。每条都是实际调试过的根因，不是推测。

## 1. shell 渲染注册组件时不传 props（最高频根因）

`apps/web/src/App.tsx` 的 `RouteView` 渲染 `routes[].Component` 时是 `<Component />`——**不传任何 props**。

- 插件视图如果声明 `({ ctx })` 并直接用 `props.ctx` → 运行时 `ctx` 为 `undefined` → 点登录报 `Cannot read properties of undefined (reading 'hostCall')`
- 正确写法：在注册文件（browser.tsx）用闭包显式传 ctx：

```tsx
const withTopNav = (View: FC) => () => <><TopBar /><View ctx={ctx} /></>
// 注册：routes: [{ path: '/', Component: withTopNav(DashboardView) }]
```

## 2. hostCall 调用形状（cordis service 方法）

```tsx
// browser 半
const r = await ctx.hostCall.hostCall(`<plugin>/<action>`, payload)
```

- 是 `ctx.hostCall.hostCall(event, payload)`，**不是** `ctx.hostCall(event, payload)`
- host 半注册：`ctx.on('<plugin>/<action>', handler)`，返回 `ApiResult`（`{ ok, data?, error?, status? }`）
- browser 半要声明注入：`(fn).inject = ['pages', 'auditClient', 'hostCall']`
- 无监听器时 host 返回结构化 `{ ok:false, error:'no handler for <event>' }`

## 3. manifest.json 契约（严格校验）

- **`routes[]` 不带 `title`**——`validateManifest` 只接受 `{path}`；带 title 直接拒绝上传
- `layout` 枚举 `['shell','fullscreen']`；`routes[].path` 匹配 `^/[a-zA-Z0-9_\-/.:]*$` 或 `''`
- **manifest.json 由 build 生成**（`scripts/build-zip.mjs` 从 package.json 的 `api-audit.manifest/browser/pages` 生成），init 不脚手架 manifest
- 改路由：改 package.json `api-audit.pages[0].routes` → build → 热传

## 4. fullscreen 路由组件必须自包含

- shell 只提供 `<div class="fullscreen-root">` + 边界，**没有共享插件级包装**——每个 route Component 自带 TopBar/导航
- 路由切换卸载视图 → 跨视图共享状态用**模块级 store**（闭包 + `useState/useEffect` 订阅），不要指望父级提升状态
- 本地导航用**绝对前缀链接**：`/pn-embedding/keys` 而非 `keys`
- 退出到壳：`navigate('/audit')`（或任意 shell 路由）

## 5. WS 冷加载竞态（刷新跳登录的真凶）

- 页面冷加载时 WS 尚未就绪，`bootstrap` 一次失败后若不再重试 → 误判未登录跳 login；手动点登录时 WS 已就绪所以成功
- 修复：bootstrap 失败/异常后 **1200ms 自动重试直到成功**（`useAuthState` 的 bootstrap 逻辑）
- 诊断手段：页面内 `new WebSocket('ws://localhost:4560')` 直连，发 `{op:'tool.invoke', payload:{event:'<plugin>/bootstrap', payload:{}, pluginRunId:'run-N'}}`，看 host 半返回 `hasBearer:true`

## 6. 接口返回结构必须实测核对（"接口有数据但前端不显示"）

GSAC（示例后端）实测结构：

| 接口 | 实际返回 | 前端曾错 |
|---|---|---|
| `/embedding/page?Page=1&Size=20&docId=X` | `data.list[].{title, strategy, chunkCount, chunkIndex, docId}`（**无 text/model/distance**） | 渲染 text/model/distance → 全空 |
| `/embedding/:id/chunks` | `data.list[].{chunkIndex, text, runeLen, byteLen, strategy}` | 取 `data.chunks ?? data.items` → 永远空 |
| `/embedding/page` 列表 | id 为大数 `3000000000000000032` | 直接传数字 → 精度丢失，须 `String(id)` |

排查套路：audit 页看请求/响应体（接口有数据）→ 对比代码字段假设 → 改前端字段映射，接口通常不用动。

## 7. 其它铁律

- **双 Router 反模式**：`<BrowserRouter>` 套壳再注册 → 破坏性，不可用；shell 是唯一外层 Router
- browser 半必须 `export default`
- react / react-dom / react-router-dom 必须 esbuild external（import map 共享同一实例；自己打包一份会导致 `useNavigate()` undefined）
- 渲染期 `navigate(...)` 是 React 警告来源 → 用 `<Navigate to="..." replace />` 声明式跳转；回调里（提交成功后）才用 `useNavigate()`
- `useLogin/useLogout` 成功后的导航目标必须真实存在（曾指向不存在的 `/pn-embedding/dashboard` → 404 空白）

## 快速验证清单（改完插件必查）

1. `npm run build` 通过（tsc + esbuild + zip）
2. 热传后页面自动切换，无 `hostCall` 报错、无 setState 警告
3. 冷加载刷新稳定进入 Dashboard（不跳 login）
4. 每个路由逐一点开（含 :id 动态路由、edit/new）
5. 列表/详情字段与接口实际返回一致
