import { canonicalJson, isJsonObject } from '../json.js'
import { MAX_RECORDED_TOOL_CALLS, type RecordedToolCall } from '../providers/types.js'
import { sha256Hex } from '../surface/hash.js'
import type { JsonObject, JsonValue, NormalizedTool } from '../types.js'

export interface CachedPick {
  pick: string | null
  arguments: JsonObject | null
  rawArguments?: string
  calls: RecordedToolCall[]
  text: string
  callCount: number
  usage?: { promptTokens?: number; completionTokens?: number }
  reasoningChars?: number

  originalLatencyMs: number
}

export interface CacheInfo {
  entries: number
  bytes: number

  location: string
}

export interface TrialCache {
  get(key: string): Promise<CachedPick | null>
  set(key: string, value: CachedPick): Promise<void>
  info(): Promise<CacheInfo>

  clear(): Promise<number>
}

export interface TrialCacheKeyInput {
  provider: string
  model: string
  endpoint?: string | null
  providerFingerprint?: string | null
  temperature: number
  seed: number | undefined

  tools: readonly NormalizedTool[]
  prompt: string
}

const INVALID_JSON = Symbol('invalid-json')

function cloneJsonValueStrict(
  value: unknown,
  ancestors = new Set<object>(),
): JsonValue | typeof INVALID_JSON {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_JSON

  if (Array.isArray(value)) {
    if (ancestors.has(value)) return INVALID_JSON
    ancestors.add(value)
    const clone: JsonValue[] = []
    for (const item of value as unknown[]) {
      const copied = cloneJsonValueStrict(item, ancestors)
      if (copied === INVALID_JSON) return INVALID_JSON
      clone.push(copied)
    }
    ancestors.delete(value)
    return clone
  }

  if (!isJsonObject(value)) return INVALID_JSON
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return INVALID_JSON
  if (ancestors.has(value)) return INVALID_JSON
  ancestors.add(value)
  const clone: JsonObject = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const copied = cloneJsonValueStrict(item, ancestors)
    if (copied === INVALID_JSON) return INVALID_JSON
    Object.defineProperty(clone, key, {
      value: copied,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  ancestors.delete(value)
  return clone
}

function cloneCall(value: unknown): RecordedToolCall | null {
  if (!isJsonObject(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null

  const name = value['name']
  if (name !== null && typeof name !== 'string') return null

  const rawArguments = value['arguments']
  let arguments_: JsonObject | null = null
  if (rawArguments !== null) {
    const copied = cloneJsonValueStrict(rawArguments)
    if (copied === INVALID_JSON || !isJsonObject(copied)) return null
    arguments_ = copied
  }

  const call: RecordedToolCall = { name, arguments: arguments_ }
  if (Object.prototype.hasOwnProperty.call(value, 'rawArguments')) {
    const raw = value['rawArguments']
    if (typeof raw !== 'string') return null
    call.rawArguments = raw
  }
  return call
}

function isNonnegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Validate an untrusted cache entry, deep-clone its JSON payloads and rebuild every legacy
 * compatibility field from the authoritative ordered call list.
 */
export function normalizeCachedPick(value: unknown): CachedPick | null {
  if (!isJsonObject(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null

  const rawCalls = value['calls']
  if (!Array.isArray(rawCalls)) return null
  // Reject before walking or cloning attacker-controlled entries. The same ceiling is
  // enforced by providers, the runner and the run-report contract.
  if (rawCalls.length > MAX_RECORDED_TOOL_CALLS) return null
  const calls: RecordedToolCall[] = []
  for (const rawCall of rawCalls as unknown[]) {
    const call = cloneCall(rawCall)
    if (call === null) return null
    calls.push(call)
  }

  if (typeof value['text'] !== 'string' || !isNonnegativeFinite(value['originalLatencyMs'])) {
    return null
  }
  if (value['reasoningChars'] !== undefined && !isNonnegativeFinite(value['reasoningChars'])) {
    return null
  }

  let usage: CachedPick['usage']
  if (value['usage'] !== undefined) {
    if (!isJsonObject(value['usage'])) return null
    const rawUsage = value['usage']
    const usagePrototype = Object.getPrototypeOf(rawUsage)
    if (usagePrototype !== Object.prototype && usagePrototype !== null) return null
    const promptTokens = rawUsage['promptTokens']
    const completionTokens = rawUsage['completionTokens']
    if (promptTokens !== undefined && !isNonnegativeFinite(promptTokens)) return null
    if (completionTokens !== undefined && !isNonnegativeFinite(completionTokens)) return null
    usage = {
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
    }
  }

  const first = calls[0]
  const projectedArguments =
    first?.arguments === null || first === undefined
      ? null
      : (cloneJsonValueStrict(first.arguments) as JsonObject)
  const normalized: CachedPick = {
    pick: first?.name ?? null,
    arguments: projectedArguments,
    calls,
    text: value['text'],
    callCount: calls.length,
    originalLatencyMs: value['originalLatencyMs'],
  }
  if (first?.rawArguments !== undefined) normalized.rawArguments = first.rawArguments
  if (usage !== undefined) normalized.usage = usage
  if (typeof value['reasoningChars'] === 'number') {
    normalized.reasoningChars = value['reasoningChars']
  }
  return normalized
}

export async function trialCacheKey(input: TrialCacheKeyInput): Promise<string> {
  const payload: JsonValue = {
    // v3 invalidates entries written before the cache preserved every tool call.
    v: 3,
    provider: input.provider,
    model: input.model,
    endpoint: input.endpoint ?? null,
    providerFingerprint: input.providerFingerprint ?? null,
    temperature: input.temperature,
    seed: input.seed ?? null,
    prompt: input.prompt,
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }
  return sha256Hex(canonicalJson(payload))
}
