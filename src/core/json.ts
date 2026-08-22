import type { JsonValue } from './types.js'

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  const parts: string[] = []
  for (const key of keys) {
    const child = value[key]
    if (child === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalJson(child)}`)
  }
  return `{${parts.join(',')}}`
}

export function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Coerce arbitrary parsed input into `JsonValue`, dropping what JSON cannot carry.
 * Anything that came from `JSON.parse` passes through untouched; this exists so that
 * hand-built fixtures and loosely typed transports cannot smuggle `undefined` or a
 * function into a structure that is about to be hashed.
 */
export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'object':
      break
    default:
      return undefined
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item) ?? null)
  }
  const out: { [key: string]: JsonValue } = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const converted = toJsonValue(child)
    if (converted !== undefined) out[key] = converted
  }
  return out
}

/** Decode one JSON Pointer reference token (RFC 6901): `~1` → `/`, `~0` → `~`. */
export function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

/**
 * Resolve a JSON Pointer against `root`. Returns `undefined` when the pointer does not
 * resolve, which callers must treat as "leave the `$ref` alone and report it".
 */
export function resolvePointer(root: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === '' || pointer === '#') return root
  const path = pointer.startsWith('#') ? pointer.slice(1) : pointer
  if (!path.startsWith('/')) return undefined

  let current: JsonValue = root
  for (const rawToken of path.slice(1).split('/')) {
    const token = decodePointerToken(decodeURIComponent(rawToken))
    if (Array.isArray(current)) {
      const index = Number(token)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index] as JsonValue
      continue
    }
    if (isJsonObject(current) && Object.prototype.hasOwnProperty.call(current, token)) {
      current = current[token] as JsonValue
      continue
    }
    return undefined
  }
  return current
}
