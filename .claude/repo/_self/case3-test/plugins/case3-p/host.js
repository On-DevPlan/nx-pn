// plugins/case3-p/host.ts
var DEFAULT_URL = "https://httpbin.org/get";
var plugin = async function plugin2(ctx, config) {
  const id = config?.name ?? "case3-p";
  ctx.logger.info(`[${id}] host half active`);
  let bootCount = 0;
  if (ctx.pluginStorage) {
    const settings = ctx.pluginStorage.table("settings");
    const current = settings.get("bootCount");
    bootCount = (typeof current === "number" ? current : 0) + 1;
    try {
      await settings.put("bootCount", bootCount);
      ctx.logger.info(`[${id}] boot #${bootCount} recorded in ns ${ctx.pluginStorage.ns}`);
    } catch (err) {
      ctx.logger.warn(`[${id}] bootCount persist failed: ${err.message}`);
    }
  }
  void ctx.auditClient.get(DEFAULT_URL).catch(() => {
  });
  ctx.on("case3-p/boot-count", () => ({ ok: true, data: { bootCount } }));
};
plugin.inject = ["auditClient"];
var host_default = plugin;
export {
  host_default as default
};
