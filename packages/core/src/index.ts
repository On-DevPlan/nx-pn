/**
 * @api-audit/core — pure contract layer (spec §3).
 *
 * Zero cordis dependency; zero Context augmentation. This package is
 * consumable by both host (Node) and client (browser) without dragging
 * cordis or any other runtime dependency across the boundary.
 */

// Version
export const CORE_API_VERSION = '0.0.0'

// AuditClient
export type { AuditClient, AuditResponse, RequestConfig } from './audit-client.js'
export { MAX_BODY_BYTES } from './audit-client.js'
