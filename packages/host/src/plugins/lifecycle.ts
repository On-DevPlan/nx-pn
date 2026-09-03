/**
 * Plugin lifecycle registry. Spec §4.4.
 *
 * One entry per {id, pluginRunId, fiber}. `stop()` awaits
 * `fiber.dispose()` (AsyncDisposable); `remove()` additionally evicts.
 */

import type { Fiber } from '../cordis/cordis-shim.js'

export interface LifecycleEntry {
  id: string
  pluginRunId: string
  fiber: Fiber
  /** Absolute path to the loaded .zip, if known. */
  zipPath?: string
  /** Compiled browser-half ESM source (if the manifest declares one). */
  browserSource?: string
  /** Manifest snapshot for list endpoints. */
  manifest: import('@api-audit/core').Manifest
}

export class PluginLifecycle {
  private readonly entries = new Map<string, LifecycleEntry>()
  private nextMonotonic = 1

  /** Allocate the next pluginRunId (monotonic). */
  nextRunId(): string {
    return `run-${this.nextMonotonic++}`
  }

  /** Register a freshly-loaded plugin. */
  register(entry: LifecycleEntry): void {
    this.entries.set(entry.pluginRunId, entry)
  }

  /** Lookup by pluginRunId. */
  byRunId(pluginRunId: string): LifecycleEntry | undefined {
    return this.entries.get(pluginRunId)
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

  /** Stop + remove from registry. */
  async remove(pluginRunId: string): Promise<void> {
    await this.stop(pluginRunId)
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