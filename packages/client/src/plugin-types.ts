/**
 * Plugin-facing types — re-exported from @flowot/nx-pn-client so plugins
 * can `import type { HostCtx } from '@flowot/nx-pn-client'` without pulling
 * in host internals.
 *
 * HostCtx mirrors what the host loader injects into a plugin half:
 *   - cordis root-context properties (logger, on, registry, root, etc.)
 *   - host-provided services (auditClient, pluginStorage, hostCall)
 *
 * References:
 *   - packages/host/src/cordis/minimal-types.ts  (CordisContextShape)
 *   - packages/host/src/cordis/host-context.ts   (AuditClientService, PluginStorageService)
 *   - packages/host/src/client/audit-client.ts   (RunConfig / AuditResponse)
 *   - packages/host/src/plugins/loader.ts:198   (wrapped plugin apply fn)
 */

import type { AuditResponse } from './types.js'
export type { AuditResponse } from './types.js'

// ------------------------------------------------------------------ AuditClientConfig

/**
 * Per-request config for auditClient calls.
 * Mirrors packages/host/src/client/audit-client.ts RunConfig.
 */
export interface AuditClientConfig {
  headers?: Record<string, string>
  timeoutMs?: number
  initiator?: string
}

// ------------------------------------------------------------------ HostCallResult

/** Return type of ctx.hostCall(event, payload). */
export interface HostCallResult {
  ok: boolean
  data?: unknown
  error?: { code: string; message?: string }
}

// ------------------------------------------------------------------ HostCtx

/**
 * The context object passed to a plugin host half by the loader.
 * Combines cordis root-context members with host-provided services.
 */
export interface HostCtx {
  // --- cordis root-context properties -----------------------------------
  /** Logger bound to the calling fiber's plugin id. */
  logger: {
    info(format: unknown, ...args: unknown[]): void
    warn(format: unknown, ...args: unknown[]): void
    error(format: unknown, ...args: unknown[]): void
  }
  /** Cordis event emitter: ctx.on('plugin/action', handler). */
  on: {
    on(event: string, handler: (...args: unknown[]) => unknown): void
    off(event: string, handler: (...args: unknown[]) => unknown): void
  }
  /** Cordis plugin registry (mostly internal; exposed for advanced use). */
  registry: unknown
  /** Root context (same as ctx when already at root). */
  root: HostCtx
  /** Optional base URL set on the host context. */
  baseUrl?: string
  /** Execute fn inside the current fiber's effect scope. */
  effect<T>(fn: () => T): T
  /** Create a child context with optional metadata. */
  extend(meta?: object): HostCtx
  /** Create an isolated child context. */
  isolate(name: string, label?: symbol): HostCtx

  // --- host-provided services -----------------------------------------
  /**
   * Audited HTTP client. All calls are recorded in the audit log
   * attributed to the calling plugin.
   */
  auditClient: {
    get(url: string, config?: AuditClientConfig): Promise<AuditResponse>
    post(url: string, body?: unknown, config?: AuditClientConfig): Promise<AuditResponse>
    put(url: string, body?: unknown, config?: AuditClientConfig): Promise<AuditResponse>
    patch(url: string, body?: unknown, config?: AuditClientConfig): Promise<AuditResponse>
    delete(url: string, config?: AuditClientConfig): Promise<AuditResponse>
  }
  /**
   * Per-plugin durable storage namespace.
   * Access via ctx.pluginStorage.table('name').
   */
  pluginStorage: {
    table(tableName: string): PluginNsTable | undefined
  }
  /**
   * Invoke a host tool event registered via ctx.on('plugin/action', handler).
   * The handler's return value is wrapped in HostCallResult.
   */
  hostCall(event: string, payload?: unknown): Promise<unknown>

  // --- catch-all for cordis dynamic services (auditStore, plugins, etc.) ---
  [key: string]: unknown
}

/** Return type of ctx.pluginStorage.table(tableName). */
export interface PluginNsTable {
  get<T = unknown>(key: string): T | undefined
  put<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

// ------------------------------------------------------------------ PluginApplyFn / PluginModule

/**
 * The function signature the host loader calls when activating a plugin.
 * Mirrors packages/host/src/plugins/loader.ts:198.
 */
export type PluginApplyFn = (ctx: HostCtx, config?: { name?: string }) => void | Promise<void>

/**
 * The module shape a plugin host-half must export.
 * Mirrors the CordisPlugin dynamic type from minimal-types.ts.
 */
export interface PluginModule {
  /** Human-readable name (optional — defaults to package name from manifest). */
  name?: string
  /** Required: called by the loader to activate the plugin. */
  apply: PluginApplyFn
}
