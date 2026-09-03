import { Ajv } from 'ajv'
import schema from './schema/manifest.schema.json' with { type: 'json' }

const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(schema)

/** Returns null when valid, otherwise an array of human-readable messages. */
export function checkManifest(json: unknown): string[] | null {
  if (validate(json)) return null
  return (validate.errors ?? []).map((e: any) => {
    const path = e.instancePath || '<root>'
    return `${path} ${e.message ?? 'invalid'}${e.params ? ' ' + JSON.stringify(e.params) : ''}`
  })
}
