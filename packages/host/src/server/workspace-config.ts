/**
 * Workspace config loader. Reads koishi.config.{yml,json} or nx-pn.config.{yml,json}
 * from a given cwd. Supports both YAML and JSON formats.
 *
 * Used by startHost to auto-load workspace plugins at startup.
 */

import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { constants } from 'node:fs'
import yaml from 'js-yaml'

export interface WorkspacePluginEntry {
  id: string
  /** Absolute path to the plugin directory (workspace/plugins/<id> or a linked path). */
  path: string
}

export interface WorkspaceConfig {
  /** All declared workspace plugins. */
  plugins: WorkspacePluginEntry[]
  /** Absolute path of the config file that was loaded. */
  configPath: string
}

/** Search order for workspace config files. */
const CONFIG_FILES = [
  'koishi.config.yml',
  'koishi.config.json',
  'nx-pn.config.yml',
  'nx-pn.config.json',
] as const

/**
 * Load a workspace config from `cwd`.
 *
 * Searches for config files in order:
 *   koishi.config.yml → koishi.config.json → nx-pn.config.yml → nx-pn.config.json
 *
 * Returns null if no config file exists in `cwd`.
 *
 * YAML format:
 *   ```yaml
 *   plugins:
 *     - id: echo
 *       path: ./plugins/echo
 *     - id: my-plugin
 *       path: ./plugins/my-plugin
 *   ```
 *
 * JSON format:
 *   ```json
 *   { "plugins": [{ "id": "echo", "path": "./plugins/echo" }] }
 *   ```
 */
export async function loadWorkspaceConfig(cwd: string): Promise<WorkspaceConfig | null> {
  for (const file of CONFIG_FILES) {
    const configPath = join(cwd, file)
    try {
      await access(configPath, constants.R_OK)
    } catch {
      continue
    }
    const raw = await readFile(configPath, 'utf-8')
    let parsed: unknown
    try {
      parsed = file.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw)
    } catch (err) {
      // Malformed YAML/JSON — skip and continue to next config file
      // eslint-disable-next-line no-console
      console.warn(`[workspace-config] failed to parse ${configPath}:`, (err as Error).message)
      continue
    }
    const plugins = normalizePlugins((parsed as { plugins?: unknown })?.plugins, cwd)
    if (plugins.length === 0 && !parsed) {
      // Empty file — treat as no config
      continue
    }
    return { plugins, configPath }
  }
  return null
}

/** Normalise the raw plugins array into WorkspacePluginEntry[]. */
function normalizePlugins(raw: unknown, cwd: string): WorkspacePluginEntry[] {
  if (!raw || !Array.isArray(raw)) return []
  const entries: WorkspacePluginEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id.trim() : ''
    const pathRaw = typeof obj.path === 'string' ? obj.path.trim() : ''
    if (!id || !pathRaw) continue
    const resolvedPath = pathRaw.startsWith('/') || /^[a-z]:/i.test(pathRaw)
      ? pathRaw
      : join(cwd, pathRaw)
    entries.push({ id, path: resolvedPath })
  }
  return entries
}
