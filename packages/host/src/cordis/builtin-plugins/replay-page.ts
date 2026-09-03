/**
 * Built-in host-half plugin: /replay page (spec §4.7).
 *
 * Forces initiator='replay:<recordId>' for the resued AuditClient
 * invocation.
 */

export const ReplayPageHostPlugin = {
  name: 'builtin/replay-page',
  apply: () => {
    // metadata only — actual rendering lives in apps/web
  },
}