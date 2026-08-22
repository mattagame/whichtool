import {
  ProviderError,
  type PickRequest,
  type PickResult,
  type Provider,
} from '../providers/types.js'
import { normalizeCachedPick, trialCacheKey, type CachedPick, type TrialCache } from './types.js'

export interface CachingStats {
  hits: number
  misses: number
  writes: number
}

export interface CachingProvider extends Provider {
  readonly cacheStats: CachingStats
}

function resultFromCacheEntry(entry: CachedPick, latencyMs: number): PickResult {
  // Normalizing a second time gives callers ownership of their result: neither calls nor
  // nested argument objects alias the cache implementation's copy.
  const cloned = normalizeCachedPick(entry)
  if (cloned === null) {
    throw new ProviderError('The trial cache returned a malformed entry.', { retryable: false })
  }
  const result: PickResult = {
    pick: cloned.pick,
    arguments: cloned.arguments,
    calls: cloned.calls,
    text: cloned.text,
    callCount: cloned.callCount,
    latencyMs,
  }
  if (cloned.rawArguments !== undefined) result.rawArguments = cloned.rawArguments
  if (cloned.usage !== undefined) result.usage = cloned.usage
  if (cloned.reasoningChars !== undefined) result.reasoningChars = cloned.reasoningChars
  return result
}

export function withCache(provider: Provider, cache: TrialCache): CachingProvider {
  const stats: CachingStats = { hits: 0, misses: 0, writes: 0 }

  return {
    id: provider.id,
    model: provider.model,
    endpoint: provider.endpoint,
    capabilities: provider.capabilities,
    ...(provider.behaviorFingerprint === undefined
      ? {}
      : { behaviorFingerprint: provider.behaviorFingerprint }),
    ...(provider.cacheFingerprint === undefined
      ? {}
      : { cacheFingerprint: provider.cacheFingerprint }),
    cacheStats: stats,

    async pick(request: PickRequest): Promise<PickResult> {
      const providerFingerprint = (await provider.cacheFingerprint?.()) ?? null
      if (provider.cacheFingerprint !== undefined && providerFingerprint === null) {
        stats.misses += 1
        return provider.pick(request)
      }
      const key = await trialCacheKey({
        provider: provider.id,
        model: provider.model,
        endpoint: provider.endpoint,
        providerFingerprint,
        temperature: request.temperature,
        seed: request.seed,
        tools: request.tools,
        prompt: request.prompt,
      })

      const hit = normalizeCachedPick(await cache.get(key))
      if (hit !== null) {
        stats.hits += 1
        return resultFromCacheEntry(hit, 0)
      }

      stats.misses += 1
      const fresh = await provider.pick(request)

      const entry = normalizeCachedPick({
        pick: fresh.pick,
        arguments: fresh.arguments,
        ...(fresh.rawArguments === undefined ? {} : { rawArguments: fresh.rawArguments }),
        calls: fresh.calls,
        text: fresh.text,
        callCount: fresh.callCount,
        originalLatencyMs: fresh.latencyMs,
        ...(fresh.usage === undefined ? {} : { usage: fresh.usage }),
        ...(fresh.reasoningChars === undefined ? {} : { reasoningChars: fresh.reasoningChars }),
      })
      if (entry === null) {
        throw new ProviderError('The provider returned a malformed pick result.', {
          retryable: false,
        })
      }
      await cache.set(key, entry)
      stats.writes += 1

      return resultFromCacheEntry(entry, fresh.latencyMs)
    },
  }
}

export function createMemoryCache(): TrialCache {
  const entries = new Map<string, CachedPick>()
  return {
    async get(key) {
      return normalizeCachedPick(entries.get(key))
    },
    async set(key, value) {
      const normalized = normalizeCachedPick(value)
      if (normalized === null) entries.delete(key)
      else entries.set(key, normalized)
    },
    async info() {
      return { entries: entries.size, bytes: 0, location: '(memory)' }
    },
    async clear() {
      const count = entries.size
      entries.clear()
      return count
    },
  }
}
