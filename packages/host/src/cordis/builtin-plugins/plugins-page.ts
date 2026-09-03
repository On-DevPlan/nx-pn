/**
 * Built-in host-half plugin: /plugins page (spec §4.7).
 */

export const PluginsPageHostPlugin = {
  name: 'builtin/plugins-page',
  apply: () => {
    // metadata only — actual rendering lives in apps/web
  },
}