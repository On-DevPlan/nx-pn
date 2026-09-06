// plugins/my-plugin/browser.tsx
import { useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var browserHalf = function browserHalf2(ctx, config) {
  const id = config?.name ?? "my-plugin";
  ctx.logger.info(`[${id}] browser half active`);
  const PageComponent = () => {
    const [count, setCount] = useState(0);
    return /* @__PURE__ */ jsxs("div", { className: "page", children: [
      /* @__PURE__ */ jsx("h1", { children: "My Plugin" }),
      /* @__PURE__ */ jsxs("div", { className: "muted", children: [
        "Plugin ",
        /* @__PURE__ */ jsx("code", { children: id }),
        " browser half."
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "card", children: [
        /* @__PURE__ */ jsx("h2", { children: "HMR Hot Update Works" }),
        /* @__PURE__ */ jsxs("p", { children: [
          "useState counter: ",
          /* @__PURE__ */ jsx("strong", { children: count })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "form-actions", children: /* @__PURE__ */ jsx("button", { onClick: () => setCount((c) => c + 1), children: "Increment" }) })
      ] })
    ] });
  };
  ctx.pages.register({
    pluginId: id,
    path: "/" + id,
    title: "My Plugin",
    order: 200,
    // 二选一：'shell' 进侧栏（默认）| 'fullscreen' 全屏（侧栏隐藏，自带导航）
    layout: "shell",
    Component: PageComponent
  });
};
browserHalf.inject = ["pages"];
var browser_default = browserHalf;
export {
  browser_default as default
};
