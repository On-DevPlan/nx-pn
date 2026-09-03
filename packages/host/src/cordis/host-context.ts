/**
 * Host cordis context. Spec §4.6.
 *
 * Wires the four core services: auditClient, auditStore, plugins,
 * credentials. They are registered as cordis Services with
 * prototype-method dispatch so the cordis caller-tracker can bind
 * `this.ctx` to the calling fiber.
 *
 * Service instances retrieve their underlying dependencies via a
 * module-scoped `HostDeps` bag set by `installCoreServices`. This keeps
 * the cordis API surface clean (no decorator metadata required).
 *
 * Prototype-method dispatch: method bodies live on `Service.prototype`
 * (not class arrow fields) per cordis's convention.
 */

import type { Manifest } from '@api-audit/core'

import type { AuditRecord } from '../client/audit-record.js'
import type { AuditRingBuffer } from '../client/ring-buffer.js'
import type { HostAuditClient } from '../client/audit-client.js'
import type { PluginLoader } from '../plugins/loader.js'
import type { PluginLifecycle, LifecycleEntry } from '../plugins/lifecycle.js'
import { CordisService, type Context } from './cordis-shim.js'

export interface HostDeps {
  ringBuffer: AuditRingBuffer<AuditRecord>
  client: HostAuditClient
  loader: PluginLoader
  lifecycle: PluginLifecycle
}

let currentDeps: HostDeps | null = null

/** Set the active dependency bag (called by startHost on each cold start). */
export function setHostDeps(deps: HostDeps): void {
  currentDeps = deps
}

/** Clear the active dependency bag (called on shutdown). */
export function clearHostDeps(): void {
  currentDeps = null
}

function requireDeps(): HostDeps {
  if (!currentDeps) {
    throw new Error('host services accessed before installCoreServices')
  }
  return currentDeps
}

/**
 * Spec §7.4 attribution: when a *plugin* calls an auditClient method,
 * cordis's caller-tracker binds `this.ctx` to the calling plugin's
 * fiber. We resolve that fiber against the lifecycle registry (fiber
 * uids are shared between the registry-returned wrapper and the raw
 * fiber) to recover the plugin id. Root / built-in callers resolve to
 * no entry → `'core'`.
 */
function callerInitiator(self: unknown): string | undefined {
  const fiber = (self as { ctx?: { fiber?: { uid?: number | null } } }).ctx?.fiber
  if (!fiber || typeof fiber.uid !== 'number' || fiber.uid <= 0) return undefined
  const entry = requireDeps().lifecycle.list().find((e) => e.fiber.uid === fiber.uid)
  return entry?.id
}

// ---------------------------------------------------------------- auditClient

export interface AuditClientService {
  client: HostAuditClient
  get(url: string, config?: Parameters<HostAuditClient['get']>[1]): ReturnType<HostAuditClient['get']>
  post(url: string, body?: unknown, config?: Parameters<HostAuditClient['post']>[2]): ReturnType<HostAuditClient['post']>
  put(url: string, body?: unknown, config?: Parameters<HostAuditClient['put']>[2]): ReturnType<HostAuditClient['put']>
  patch(url: string, body?: unknown, config?: Parameters<HostAuditClient['patch']>[2]): ReturnType<HostAuditClient['patch']>
  delete(url: string, config?: Parameters<HostAuditClient['delete']>[1]): ReturnType<HostAuditClient['delete']>
}

export class AuditClientService extends CordisService {
  static readonly service = 'auditClient'
  declare get: AuditClientService['get']
  declare post: AuditClientService['post']
  declare put: AuditClientService['put']
  declare patch: AuditClientService['patch']
  declare delete: AuditClientService['delete']

  constructor(ctx: Context) {
    super(ctx, 'auditClient')
  }
}

const auditClientProto = AuditClientService.prototype as unknown as Record<string, unknown>
auditClientProto.get = function (this: unknown, url: string, config?: Parameters<HostAuditClient['get']>[1]) {
  const initiator = callerInitiator(this)
  return requireDeps().client.get(url, initiator ? { ...config, initiator } : config)
}
auditClientProto.post = function (this: unknown, url: string, body?: unknown, config?: Parameters<HostAuditClient['post']>[2]) {
  const initiator = callerInitiator(this)
  return requireDeps().client.post(url, body as never, initiator ? { ...config, initiator } : config)
}
auditClientProto.put = function (this: unknown, url: string, body?: unknown, config?: Parameters<HostAuditClient['put']>[2]) {
  const initiator = callerInitiator(this)
  return requireDeps().client.put(url, body as never, initiator ? { ...config, initiator } : config)
}
auditClientProto.patch = function (this: unknown, url: string, body?: unknown, config?: Parameters<HostAuditClient['patch']>[2]) {
  const initiator = callerInitiator(this)
  return requireDeps().client.patch(url, body as never, initiator ? { ...config, initiator } : config)
}
auditClientProto.delete = function (this: unknown, url: string, config?: Parameters<HostAuditClient['delete']>[1]) {
  const initiator = callerInitiator(this)
  return requireDeps().client.delete(url, initiator ? { ...config, initiator } : config)
}

// ----------------------------------------------------------------- auditStore

export interface AuditStoreService {
  snapshot(): AuditRecord[]
  since(sinceId: number): AuditRecord[]
  get(id: number): AuditRecord | undefined
  lastId(): number
}

export class AuditStoreService extends CordisService {
  static readonly service = 'auditStore'
  declare snapshot: AuditStoreService['snapshot']
  declare since: AuditStoreService['since']
  declare get: AuditStoreService['get']
  declare lastId: AuditStoreService['lastId']

  constructor(ctx: Context) {
    super(ctx, 'auditStore')
  }
}

const auditStoreProto = AuditStoreService.prototype as unknown as Record<string, unknown>
auditStoreProto.snapshot = function (): AuditRecord[] {
  return requireDeps().ringBuffer.snapshot()
}
auditStoreProto.since = function (sinceId: number): AuditRecord[] {
  return requireDeps().ringBuffer.since(sinceId)
}
auditStoreProto.get = function (id: number): AuditRecord | undefined {
  return requireDeps().ringBuffer.get(id)
}
auditStoreProto.lastId = function (): number {
  return requireDeps().ringBuffer.lastId
}

// ------------------------------------------------------------------- plugins

export interface PluginsService {
  list(): LifecycleEntry[]
  stop(pluginRunId: string): Promise<void>
  remove(pluginRunId: string): Promise<void>
  load(zipBytes: Uint8Array): Promise<{ id: string; pluginRunId: string; manifest: Manifest }>
}

export class PluginsService extends CordisService {
  static readonly service = 'plugins'
  declare list: PluginsService['list']
  declare stop: PluginsService['stop']
  declare remove: PluginsService['remove']
  declare load: PluginsService['load']

  constructor(ctx: Context) {
    super(ctx, 'plugins')
  }
}

const pluginsProto = PluginsService.prototype as unknown as Record<string, unknown>
pluginsProto.list = function (): LifecycleEntry[] {
  return requireDeps().lifecycle.list()
}
pluginsProto.stop = async function (pluginRunId: string): Promise<void> {
  await requireDeps().lifecycle.stop(pluginRunId)
}
pluginsProto.remove = async function (pluginRunId: string): Promise<void> {
  await requireDeps().lifecycle.remove(pluginRunId)
}
pluginsProto.load = async function (zipBytes: Uint8Array) {
  const r = await requireDeps().loader.load({ zipBytes })
  return { id: r.id, pluginRunId: r.pluginRunId, manifest: r.manifest }
}

// --------------------------------------------------------------- credentials

export interface CredentialsService {
  resolve(hash: string): string | undefined
}

export class CredentialsService extends CordisService {
  static readonly service = 'credentials'
  declare resolve: CredentialsService['resolve']

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }
}

const credentialsProto = CredentialsService.prototype as unknown as Record<string, unknown>
credentialsProto.resolve = function (_hash: string): string | undefined {
  // MVP: no persistent credential store. Always returns undefined.
  return undefined
}

// ------------------------------------------------------------------- wiring

/** Wire all four core services into a fresh Context. */
export function installCoreServices(ctx: Context, deps: HostDeps): void {
  setHostDeps(deps)
  ctx.registry.plugin(AuditClientService, {})
  ctx.registry.plugin(AuditStoreService, {})
  ctx.registry.plugin(PluginsService, {})
  ctx.registry.plugin(CredentialsService, {})
}