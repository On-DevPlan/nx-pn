import { checkManifest } from './manifest-schema.js'

export const MANIFEST_VERSION = 1
export const MAX_ZIP_BYTES = 4 * 1024 * 1024

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** A plugin-owned sub-route (fullscreen pages). Relative to the page
 * prefix: '/detail', '/keys', or '/' for the bare prefix. Declared for
 * docs/validation only — the half supplies the Components. */
export interface PageRouteDeclaration {
  path: string
}

export interface PageDeclaration {
  path: string
  title: string
  icon?: string
  order?: number
  /** 'shell' (default) | 'fullscreen' */
  layout?: 'shell' | 'fullscreen'
  /** Plugin-owned sub-routes (fullscreen pages); declared for
   * docs/validation only — the half supplies the Components. */
  routes?: PageRouteDeclaration[]
}

export interface HalfEntry {
  entry: string
  pages?: PageDeclaration[]
  inject?: string[]
}

export interface Manifest {
  schemaVersion: typeof MANIFEST_VERSION
  id: string
  version: string
  title: string
  halves: {
    host?: HalfEntry
    browser?: HalfEntry
  }
  inject?: string[]
}

/**
 * Throws an Error with a multi-line `.message` listing every schema violation.
 * Returns the validated (and structurally identical) manifest on success.
 */
export function validateManifest(json: unknown): Manifest {
  const errors = checkManifest(json)
  if (errors) {
    throw new Error('Invalid manifest:\n  - ' + errors.join('\n  - '))
  }
  // json is validated above; the cast is safe because checkManifest guarantees shape.
  return json as Manifest
}
