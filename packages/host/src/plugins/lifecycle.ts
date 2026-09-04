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
 */

import type { Fiber } from '../cordis/cordis-shim.js'
import type { BrowserHalfPusher } from '../ws/browser-half-pusher.js'

export interface LifecycleEntry {
  id: string
  pluginRunId: string
  fiber: Fiber
  /** Absolute path to the loaded .zip, if known. */
  zipPath?: string
  /** Compiled browser-half ESM source (if the manifest declares one). */
  browserSource?: string
  /** Manifest snapshot for list endpoints. */
  manifest: import('@flowot/nx-pn-core').Manifest
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

  /** Register a freshly-loaded plugin. */
  register(entry: LifecycleEntry): void {
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
      await entry.fiber.dispose()
    } catch {
      // swallow; disposal errors shouldn't bubble
    }
  }

  /**
   * Stop + remove from registry. Broadcasts `browser-half.retract` to
   * connected browsers (if a pusher is wired) carrying both the run id
   * and the manifest id, so the browser side can match and unregister
   * pages even when a re-upload swapped the pluginRunId for the same id.
   */
  async remove(pluginRunId: string): Promise<void> {
    const entry = this.entries.get(pluginRunId)
    const id = entry?.id
    await this.stop(pluginRunId)
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
  }
}