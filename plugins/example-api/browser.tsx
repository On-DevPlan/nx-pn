/**
 * example-api — browser half of the demo dual-half zip plugin (spec §5.2,
 * §5.3). Compiled to an ESM string by `scripts/build-zip.mjs` (platform
 * browser, jsx automatic, shared deps external) and shipped inside the
 * zip as `browser.js`.
 *
 * When a browser runtime loads this half (WS `browser-half.load` → blob
 * import → cordis plugin), it registers its navigation entry through the
 * Pages service — the exact contract `packages/client` defines. The
 * registration attaches to this half's fiber effect chain, so disposing
 * the plugin removes the entry automatically.
 *
 * The component itself is a real React function component that uses the
 * shared `useState` hook from React and `Link` / `useNavigate` from
 * `react-router-dom` — both resolved at runtime via the web shell's
 * import map (spec §5.2.2). Building it into a half the web shell can
 * mount proves the single-React invariant end-to-end (no "Invalid hook
 * call", no router-context mismatch).
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

/** Structural view of the browser plugin ctx this half relies on. */
interface BrowserCtx {
  logger: {
    info(message: string): void
  }
  /** Pages service (spec §5.3, prototype methods). */
  pages: {
    register(entry: {
      pluginId: string
      path: string
      title: string
      order?: number
      icon?: string
      Component?: unknown
    }): unknown
  }
}

/**
 * The plugin's own page — a real React component the host shell renders
 * at `/example-api`. State is local; the router context comes from the
 * shell's <BrowserRouter>. Both prove the half shares the app's React
 * + react-router-dom instances (spec §5.2.2).
 */
export function ExampleApiPage() {
  const [count, setCount] = useState(0)
  const navigate = useNavigate()
  return (
    <div className="page">
      <h1>示例 API 插件页面</h1>
      <div className="muted">此页面由插件自带 UI 提供（来自 example-api 浏览器半）。</div>

      <section className="card">
        <h2>共享 React 校验</h2>
        <p>本页由插件动态注册，使用的是宿主 web 应用的同一份 React（import map 共享）：</p>
        <ul>
          <li>useState hook：本按钮已被点击 <strong>{count}</strong> 次。</li>
          <li>react-router-dom：本页是路由 <code>/example-api</code> 的命中。</li>
        </ul>
        <div className="form-actions">
          <button onClick={() => setCount((c) => c + 1)}>点我</button>
        </div>
      </section>

      <section className="card">
        <h2>宿主侧默认接口</h2>
        <p>
          插件的 host 半在激活时调用了 <code>https://httpbin.org/get</code>，记录可在
          <Link to="/audit"> 审计记录</Link>页面中以 <code>initiator: example-api</code> 查看。
        </p>
        <div className="form-actions">
          <button onClick={() => navigate('/audit')}>跳到审计记录</button>
        </div>
      </section>
    </div>
  )
}

const browserHalf = function browserHalf(ctx: BrowserCtx): void {
  ctx.logger.info('[example-api] browser half active — registering /example-api')
  ctx.pages.register({
    pluginId: 'example-api',
    path: '/example-api',
    title: '示例 API',
    order: 200,
    Component: ExampleApiPage,
  })
}

// cordis reads `inject` off the plugin value; declare our service need.
;(browserHalf as typeof browserHalf & { inject?: string[] }).inject = ['pages']

export default browserHalf