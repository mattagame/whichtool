import { canonicalJson, toJsonValue } from '../json.js'
import { sha256Hex } from '../surface/hash.js'
import type { Provider } from './types.js'

/**
 * Hash provider construction options once, so credentials can influence cache isolation
 * without ever being exposed by the Provider object or written to disk.
 */
export function createProviderCacheFingerprint(value: unknown): Provider['cacheFingerprint'] {
  const serializable = toJsonValue(value) ?? null
  const digest = sha256Hex(canonicalJson(serializable))
  return () => digest
}

/** Stable, non-secret identity suitable for run reports and comparability checks. */
export function createProviderBehaviorFingerprint(
  value: unknown,
): NonNullable<Provider['behaviorFingerprint']> {
  const serializable = toJsonValue(value) ?? null
  return async () => sha256Hex(canonicalJson(serializable))
}

/**
 * Preserve behaviour-changing header names while excluding credential material from reports.
 * Credential values remain present in the separate cache fingerprint.
 */
export function reportableProviderHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    safe[name.toLowerCase()] = /authorization|api[-_]?key|token|secret|cookie/i.test(name)
      ? '(credential)'
      : value
  }
  return safe
}

/** A dynamic provider whose behaviour cannot be represented must not reuse stored picks. */
export const uncacheableProviderFingerprint: NonNullable<Provider['cacheFingerprint']> = async () =>
  null
