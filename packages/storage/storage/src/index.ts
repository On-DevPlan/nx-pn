/**
 * Storage hub: a named backend registry plus mounted data-form facilities.
 * The hub itself performs no IO — backends own media, data forms (the domain
 * layer first) own semantics. This is a PURE LIBRARY (no cordis): assembly
 * happens on the host side, which constructs `new Storage()`, registers
 * backends under `backend`, and mounts data-form facilities under their
 * `StorageForms` key.
 * @module @flowot/nx-pn-storage
 */

import { StorageError } from './error.js'
import { BackendRegistry } from './registry.js'

export { BackendRegistry } from './registry.js'
export { StorageError } from './error.js'
export type { StorageErrorCode } from './error.js'
export { UNIT_NAME_RE } from './backend.js'
export type { StorageBackend, KvFacet, KvUnit, KvUnitDescriptor } from './backend.js'

/**
 * Derive the lifecycle service key that one named backend plugin provides.
 * In dsh this was the Cordis lifecycle-only service key used to gate backend
 * activation; the nx-pn host keeps it as a diagnostic key for assembly
 * (no cordis `provide` semantics remain).
 * @param name - Backend registry name.
 * @returns the corresponding lifecycle-only service key.
 */
export function storageBackendServiceKey(name: string): string {
  return `storage.backend.${name}`
}

/**
 * Data forms mountable on the hub, keyed by form name. Form owners may extend
 * this map via declaration merging (the domain layer merged
 * `domain: DomainFacility`) and mount the facility through {@link Storage.mount}.
 */
export interface StorageForms {}

/**
 * The storage hub. Backends register under {@link Storage.backend}; data forms
 * mount under their `StorageForms` key and are reached through {@link Storage.form}.
 * A host constructs one instance and owns its lifecycle.
 */
export class Storage {
  /** Named backend table; multiple backends stay mounted side by side. */
  readonly backend: BackendRegistry = new BackendRegistry()

  private readonly forms = new Map<keyof StorageForms, unknown>()

  /**
   * Mount a data-form facility on the hub. Mounting is an effect: the
   * returned disposer unmounts the form.
   * @param form - Form key declared in {@link StorageForms}.
   * @param facility - The facility instance to expose.
   * @returns the disposer that unmounts the form.
   */
  mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void {
    if (this.forms.has(form)) {
      throw new StorageError('duplicate-mount', `storage form '${String(form)}' is already mounted`)
    }
    this.forms.set(form, facility)
    return () => {
      // Same stale-disposer guard as BackendRegistry.register.
      if (this.forms.get(form) === facility) {
        this.forms.delete(form)
      }
    }
  }

  /**
   * Resolve a mounted data form.
   * @param form - Form key declared in {@link StorageForms}.
   * @returns the mounted facility.
   */
  form<K extends keyof StorageForms>(form: K): StorageForms[K] {
    if (!this.forms.has(form)) {
      throw new StorageError('form-not-mounted', `storage form '${String(form)}' is not mounted`)
    }
    return this.forms.get(form) as StorageForms[K]
  }

  /** Domain data form; present once the domain layer facility is mounted. */
  get domain(): StorageForms extends { domain: infer D } ? D : never {
    return this.form('domain' as keyof StorageForms)
  }
}
