/**
 * Built-in host-half plugin: /audit page (spec §4.7).
 *
 * Registers metadata on `ctx.auditStore` consumer; the actual React
 * component is delivered by apps/web (Plan 3).
 */

export const AuditPageHostPlugin = {
  name: 'builtin/audit-page',
  apply: () => {
    // metadata only — actual rendering lives in apps/web
  },
}