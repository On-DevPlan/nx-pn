/**
 * Plugin lifecycle registry. Spec §4.4.
 *
 * One entry per {id, pluginRunId, fiber}. `stop()` awaits
 * `fiber.dispose()` (AsyncDisposable); `remove()` additionally evicts.
 *
 * Re-upload dedup: when a fresh upload / install replaces a previously-
 * registered run of the same manifest id, `lifecycle.remove(oldRunId)` is
 * the single point that tears it down. It both awaits the cordis fiber's
 * dispose (which runs the plugin half's `ctx.effect(...)` disposers — the
 * Pages service unregisters the host pages) AND, if a `BrowserHalfPusher`
 * has been wired, broadcasts a `browser-half.retract` frame so connected
 * browsers dispose the matching browser-half fiber + drop the entries from
 * their PageRegistry. Loading / installing a new run of the same id is
 * therefore guaranteed to leave at most one active entry per manifest id.
 *
 * Namespace storage (v2): every entry owns a `plugin-<id>` storage domain
 * opened on `register` (an async open kicked off synchronously — the caller
 * awaits `entry.storagePromise` before activating the fiber). `remove` /
 * `stopAll` close that domain AFTER the fiber disposes, so a plugin cannot
 * write past its own teardown while its durable data survives re-installs.
 */

import type { Fiber } from '../cordis/cordis-shim.js'
import type { BrowserHalfPusher } from '../ws/browser-half-pusher.js'
import type { Domain } from '@flowot/nx-pn-storage-domain'

export interface LifecycleEntry {
  id: string
  pluginRunId: string
  /**
   * The plugin's cordis fiber. Back-filled by the loader / installer
   * AFTER `registry.plugin(...)` returns — the entry is registered (and
   * its namespace storage domain opened) BEFORE the fiber exists, so
   * apply-time `ctx.pluginStorage` is always backed by an open domain.
   */
  fiber?: Fiber
  /** Absolute path to the loaded .zip, if known. */
  zipPath?: string
  /** Compiled browser-half ESM source (if the manifest declares one). */
  browserSource?: string
  /** Manifest snapshot for list endpoints. */
  manifest: import('@flowot/nx-pn-core').Manifest
  /**
   * Namespace storage (v2): resolves when the `plugin-<id>` storage domain
   * is open. Set by `register`; the loader / installer awaits it before
   * activating the fiber, so apply-time `ctx.pluginStorage` is live.
   */
  storagePromise?: Promise<Domain<import('@flowot/nx-pn-storage-domain').DomainSpec>>
  /** The opened namespace domain (back-filled when storagePromise resolves). */
  storageDomain?: Domain<import('@flowot/nx-pn-storage-domain').DomainSpec>
}

export class PluginLifecycle {
  private readonly entries = new Map<string, LifecycleEntry>()
  private nextMonotonic = 1
  /**
   * Optional browser-half pusher — when set, `remove()` broadcasts a
   * `browser-half.retract` frame so connected browsers drop the old
   * browser-half fiber + pages. Wired by startHost() after both
   * PluginLifecycle and BrowserHalfPusher are constructed (the
   * dependency is injected, not imported at module-top, to keep
   * lifecycle.ts free of WS types in tests).
   */
  private browserHalfPusher: BrowserHalfPusher | undefined
  /**
   * WS broadcast for plugin lifecycle events (plugin.changed). When set,
   * `stop`/`remove` push a lifecycle event so clients can show the
   * event panel and refresh live.
   */
  private broadcast: ((op: 'plugin.changed', payload: unknown) => void) | undefined
  /**
   * Namespace-storage opener injected by startHost after the storage
   * facility is assembled. `register` calls it synchronously so the
   * returned promise is captured on the entry before any await point.
   */
  private openPluginNs:
    | ((id: string) => Promise<Domain<import('@flowot/nx-pn-storage-domain').DomainSpec>>)
    | undefined

  /** Allocate the next pluginRunId (monotonic). */
  nextRunId(): string {
    return `run-${this.nextMonotonic++}`
  }

  /**
   * Inject the WS browser-half pusher. Once set, every `remove()` will
   * broadcast `browser-half.retract { id, pluginRunId }` to connected
   * browsers so the old browser half's pages are evicted there too.
   * Re-setting replaces the prior pusher.
   */
  setBrowserHalfPusher(pusher: BrowserHalfPusher): void {
    this.browserHalfPusher = pusher
  }

  /**
   * Inject the WS lifecycle-event broadcaster. Once set, `stop()` and
   * `remove()` push a `plugin.changed` event for the event panel.
   */
  setLifecycleBroadcast(broadcast: (op: 'plugin.changed', payload: unknown) => void): void {
    this.broadcast = broadcast
  }

  /**
   * Inject the namespace-storage opener. Once set, every `register` opens a
   * `plugin-<id>` storage domain for the entry (the load awaits it before
   * activating the fiber). Re-setting replaces the prior opener.
   */
  setPluginNsOpener(
    opener: (id: string) => Promise<Domain<import('@flowot/nx-pn-storage-domain').DomainSpec>>,
  ): void {
    this.openPluginNs = opener
  }

  /** Register a freshly-loaded plugin. Opens the namespace domain (async). */
  register(entry: LifecycleEntry): void {
    if (this.openPluginNs) {
      const opened = this.openPluginNs(entry.id)
      // Back-fill the resolved domain onto the same entry object the
      // loader / installer already holds, so by the time they await the
      // promise the domain is reachable on the entry too.
      const promise = opened.then((domain) => {
        entry.storageDomain = domain
        return domain
      })
      entry.storagePromise = promise
    }
    this.entries.set(entry.pluginRunId, entry)
  }

  /** Lookup by pluginRunId. */
  byRunId(pluginRunId: string): LifecycleEntry | undefined {
    return this.entries.get(pluginRunId)
  }

  /**
   * Find every entry whose manifest id matches. Returns a snapshot array
   * (safe to iterate while removing). Used by the loader / installer to
   * detect re-upload dedup targets.
   */
  listById(id: string): LifecycleEntry[] {
    const out: LifecycleEntry[] = []
    for (const e of this.entries.values()) {
      if (e.id === id) out.push(e)
    }
    return out
  }

  /** All entries (snapshot). */
  list(): LifecycleEntry[] {
    return [...this.entries.values()]
  }

  /** Stop and dispose a plugin by pluginRunId. Idempotent. */
  async stop(pluginRunId: string): Promise<void> {
    const entry = this.entries.get(pluginRunId)
    if (!entry) return
    try {
      await entry.fiber?.dispose()
    } catch {
      // swallow; disposal errors shouldn't bubble
    }
  }

  /**
   * Stop + remove from registry. Broadcasts `browser-half.retract` to
   * connected browsers (if a pusher is wired) carrying both the run id
   * and the manifest id, so the browser side can match and unregister
   * pages even when a re-upload swapped the pluginRunId for the same id.
   *
   * The namespace storage domain (v2) closes AFTER the fiber is disposed
   * — a stopped plugin can no longer write, and in-flight durable writes
   * drain before the domain releases its unit. Data persists (re-install
   * regains the same records).
   */
  async remove(pluginRunId: string): Promise<void> {
    const entry = this.entries.get(pluginRunId)
    const id = entry?.id
    const storageDomain = entry?.storageDomain
    const storagePromise = entry?.storagePromise
    await this.stop(pluginRunId)
    if (storageDomain) {
      try {
        await storageDomain.close()
      } catch {
        // swallow — a failing close must not block the retract/eviction
      }
    } else if (storagePromise) {
      // The ns open was still in flight when this remove landed (a race
      // with a concurrent load): close the domain as soon as it opens so
      // no orphan stays registered on the facility.
      storagePromise.then(
        (domain) => { void domain.close().catch(() => {}) },
        () => { /* open failed — nothing to close */ },
      )
    }
    if (this.browserHalfPusher) {
      // Best-effort broadcast — never throws. Browser half retract is
      // idempotent on the client side; an entry without a browser half
      // (no source) is still safe to send (the client matches by
      // pluginRunId/id and no-ops when the half isn't loaded).
      this.browserHalfPusher.retract(pluginRunId, id)
    }
    this.entries.delete(pluginRunId)
  }

  /** Stop everything (used on shutdown). */
  async stopAll(): Promise<void> {
    const all = [...this.entries.values()]
    for (const e of all) {
      await this.stop(e.pluginRunId)
    }
    // Namespace domains close after every fiber is disposed (plugins can
    // no longer write). Domains left open here are also reclaimed by the
    // storage facility's closeAll at host stop — double close is
    // idempotent, so this is belt-and-braces.
    for (const e of all) {
      if (e.storageDomain) {
        try {
          await e.storageDomain.close()
        } catch {
          // swallow
        }
      }
    }
  }
}