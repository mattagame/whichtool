import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryCache, withCache } from '../src/core/cache/provider.js'
import {
  normalizeCachedPick,
  trialCacheKey,
  type CachedPick,
  type TrialCache,
} from '../src/core/cache/types.js'
import { planTrials } from '../src/core/eval/planner.js'
import { runTrials } from '../src/core/eval/runner.js'
import { createKeywordProvider, createMockProvider } from '../src/core/providers/mock.js'
import { createOpenAiCompatibleProvider } from '../src/core/providers/openai-compatible.js'
import { MAX_RECORDED_TOOL_CALLS, type Provider } from '../src/core/providers/types.js'
import { normalizeTools } from '../src/core/surface/normalize.js'
import type { Task } from '../src/core/tasks/schema.js'
import { createFileCache, MAX_CACHE_ENTRY_BYTES } from '../src/runtime/file-cache.js'
import type { PickRequest } from '../src/core/providers/types.js'
import type { JsonObject, RawTool } from '../src/core/types.js'

const TOOLS = normalizeTools([
  { name: 'a', description: 'Tool A.', inputSchema: { type: 'object' } },
  { name: 'b', description: 'Tool B.', inputSchema: { type: 'object' } },
] as RawTool[]).tools

const BASE = {
  provider: 'ollama',
  model: 'qwen3:4b',
  endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
  temperature: 0,
  seed: undefined,
  tools: TOOLS,
  prompt: 'list them',
}

describe('trialCacheKey', () => {
  test('is stable for identical input', async () => {
    expect(await trialCacheKey(BASE)).toBe(await trialCacheKey({ ...BASE }))
  })

  test('changes with the endpoint, model, temperature, seed and prompt', async () => {
    const base = await trialCacheKey(BASE)
    expect(
      await trialCacheKey({ ...BASE, endpoint: 'http://other.test/v1/chat/completions' }),
    ).not.toBe(base)
    expect(await trialCacheKey({ ...BASE, model: 'other' })).not.toBe(base)
    expect(await trialCacheKey({ ...BASE, temperature: 0.7 })).not.toBe(base)
    expect(await trialCacheKey({ ...BASE, seed: 1 })).not.toBe(base)
    expect(await trialCacheKey({ ...BASE, prompt: 'other' })).not.toBe(base)
    expect(await trialCacheKey({ ...BASE, providerFingerprint: 'other' })).not.toBe(base)
  })

  test('provider fingerprints include reasoning, headers, credentials and transport options', async () => {
    const fingerprint = async (
      overrides: Partial<Parameters<typeof createOpenAiCompatibleProvider>[0]> = {},
    ) =>
      createOpenAiCompatibleProvider({
        baseUrl: 'https://example.test/v1',
        model: 'gpt-test',
        apiKey: 'secret-a',
        reasoningEffort: 'none',
        headers: { 'x-project': 'one' },
        ...overrides,
      }).cacheFingerprint?.()

    const base = await fingerprint()
    expect(await fingerprint({ reasoningEffort: 'medium' })).not.toBe(base)
    expect(await fingerprint({ headers: { 'x-project': 'two' } })).not.toBe(base)
    expect(await fingerprint({ apiKey: 'secret-b' })).not.toBe(base)
    expect(await fingerprint({ timeoutMs: 1234 })).not.toBe(base)
  })

  test('the reportable request fingerprint tracks behaviour without fingerprinting credentials', async () => {
    const fingerprint = async (
      overrides: Partial<Parameters<typeof createOpenAiCompatibleProvider>[0]> = {},
    ) =>
      createOpenAiCompatibleProvider({
        baseUrl: 'https://example.test/v1',
        model: 'gpt-test',
        apiKey: 'secret-a',
        reasoningEffort: 'none',
        headers: { 'x-project': 'one' },
        ...overrides,
      }).behaviorFingerprint?.()

    const base = await fingerprint()
    expect(await fingerprint({ apiKey: 'secret-b' })).toBe(base)
    expect(await fingerprint({ reasoningEffort: 'medium' })).not.toBe(base)
    expect(await fingerprint({ headers: { 'x-project': 'two' } })).not.toBe(base)
    expect(await fingerprint({ timeoutMs: 1234 })).not.toBe(base)
  })

  test('changes when a tool description changes, so a new surface misses rather than replaying', async () => {
    const edited = normalizeTools([
      { name: 'a', description: 'Tool A, rewritten.', inputSchema: { type: 'object' } },
      { name: 'b', description: 'Tool B.', inputSchema: { type: 'object' } },
    ] as RawTool[]).tools
    expect(await trialCacheKey({ ...BASE, tools: edited })).not.toBe(await trialCacheKey(BASE))
  })

  test('changes with the tool order, because a permutation is a different question', async () => {
    // Collapsing permutations onto one key would silently destroy position sensitivity.
    const reversed = [...TOOLS].reverse()
    expect(await trialCacheKey({ ...BASE, tools: reversed })).not.toBe(await trialCacheKey(BASE))
  })
})

function request(prompt: string): PickRequest {
  return { tools: TOOLS, prompt, temperature: 0 }
}

describe('withCache', () => {
  test('asks the provider once and replays afterwards', async () => {
    const inner = createKeywordProvider({ list: 'a' })
    const cached = withCache(inner, createMemoryCache())

    const first = await cached.pick(request('list them'))
    const second = await cached.pick(request('list them'))

    expect(first.pick).toBe('a')
    expect(second.pick).toBe('a')
    expect(inner.calls).toHaveLength(1)
    expect(cached.cacheStats).toEqual({ hits: 1, misses: 1, writes: 1 })
  })

  test('a replayed trial reports zero latency, not the latency someone else paid', async () => {
    const inner = createMockProvider({ cycle: true, script: [{ pick: 'a', latencyMs: 50_000 }] })
    const cached = withCache(inner, createMemoryCache())

    expect((await cached.pick(request('x'))).latencyMs).toBe(50_000)
    expect((await cached.pick(request('x'))).latencyMs).toBe(0)
  })

  test('a different prompt is a different trial', async () => {
    const inner = createKeywordProvider({ list: 'a', find: 'b' })
    const cached = withCache(inner, createMemoryCache())
    await cached.pick(request('list them'))
    await cached.pick(request('find one'))
    expect(inner.calls).toHaveLength(2)
    expect(cached.cacheStats.hits).toBe(0)
  })

  test('a failure is never cached, so a rate limit cannot become a permanent answer', async () => {
    let calls = 0
    const flaky = createMockProvider({
      script: () => {
        calls += 1
        if (calls === 1) return { pick: null, error: { message: '429', retryable: true } }
        return { pick: 'a' }
      },
    })
    const cached = withCache(flaky, createMemoryCache())

    await expect(cached.pick(request('x'))).rejects.toThrow('429')
    expect((await cached.pick(request('x'))).pick).toBe('a')
    expect(calls).toBe(2)
  })

  test("preserves the provider's identity and declared capabilities", () => {
    const inner = createKeywordProvider({})
    const cached = withCache(inner, createMemoryCache())
    expect(cached.id).toBe(inner.id)
    expect(cached.model).toBe(inner.model)
    expect(cached.capabilities).toEqual(inner.capabilities)
  })

  test('keeps repeated trials distinct, then replays the same run', async () => {
    const tasks: Task[] = [{ id: 't', prompt: 'list them', expected: 'a', tags: [] }]
    const plan = planTrials(tasks, TOOLS, { repeat: 5 })
    const inner = createKeywordProvider({ list: 'a' })
    const cached = withCache(inner, createMemoryCache())

    await runTrials(plan, tasks, TOOLS, cached)
    expect(inner.calls).toHaveLength(5)
    expect(new Set(inner.calls.map((call) => call.seed)).size).toBe(5)

    await runTrials(plan, tasks, TOOLS, cached)
    expect(inner.calls).toHaveLength(5)
    expect(cached.cacheStats.hits).toBe(5)
  })

  test('a replay preserves usage metadata', async () => {
    const inner: Provider = {
      id: 'mock',
      model: 'mock-1',
      endpoint: null,
      capabilities: { seed: true, temperatureZero: true, logprobs: false, disableThinking: true },
      async pick() {
        return {
          pick: 'a',
          arguments: null,
          calls: [
            { name: 'a', arguments: null },
            { name: 'b', arguments: { q: 'x' } },
          ],
          text: '',
          callCount: 2,
          latencyMs: 2,
          usage: { promptTokens: 10, completionTokens: 3 },
          reasoningChars: 7,
        }
      },
    }
    const cached = withCache(inner, createMemoryCache())
    await cached.pick(request('x'))
    expect(await cached.pick(request('x'))).toMatchObject({
      calls: [
        { name: 'a', arguments: null },
        { name: 'b', arguments: { q: 'x' } },
      ],
      callCount: 2,
      usage: { promptTokens: 10, completionTokens: 3 },
      reasoningChars: 7,
    })
  })

  test('treats a structurally corrupt cache hit as a miss and repairs it', async () => {
    const writes: CachedPick[] = []
    const corrupt: TrialCache = {
      async get() {
        return { calls: 'not-an-array' } as unknown as CachedPick
      },
      async set(_key, value) {
        writes.push(value)
      },
      async info() {
        return { entries: 1, bytes: 1, location: '(broken)' }
      },
      async clear() {
        return 1
      },
    }
    const inner = createKeywordProvider({ list: 'a' })
    const cached = withCache(inner, corrupt)

    expect((await cached.pick(request('list them'))).pick).toBe('a')
    expect(inner.calls).toHaveLength(1)
    expect(writes).toHaveLength(1)
    expect(cached.cacheStats).toEqual({ hits: 0, misses: 1, writes: 1 })
  })

  test('rejects an oversized calls array before accepting a cache entry', () => {
    expect(
      normalizeCachedPick({
        calls: Array.from({ length: MAX_RECORDED_TOOL_CALLS + 1 }, () => ({
          name: 'a',
          arguments: null,
        })),
        text: '',
        originalLatencyMs: 0,
      }),
    ).toBeNull()
  })

  test('reprojects compatibility fields from calls on every cache hit', async () => {
    const stale: TrialCache = {
      async get() {
        return {
          pick: 'stale-pick',
          arguments: { stale: true },
          rawArguments: 'stale raw arguments',
          calls: [
            { name: 'b', arguments: { nested: { value: 'kept' } } },
            { name: 'a', arguments: null },
          ],
          text: '',
          callCount: 99,
          originalLatencyMs: 12,
        }
      },
      async set() {},
      async info() {
        return { entries: 1, bytes: 1, location: '(stale)' }
      },
      async clear() {
        return 1
      },
    }
    const inner = createKeywordProvider({ list: 'a' })
    const cached = withCache(inner, stale)

    const result = await cached.pick(request('list them'))
    expect(result).toMatchObject({
      pick: 'b',
      arguments: { nested: { value: 'kept' } },
      callCount: 2,
    })
    expect(result.rawArguments).toBeUndefined()
    expect(inner.calls).toHaveLength(0)
  })

  test('does not share mutable argument objects with callers', async () => {
    const inner: Provider = {
      id: 'mock',
      model: 'mock-1',
      endpoint: null,
      capabilities: { seed: true, temperatureZero: true, logprobs: false, disableThinking: true },
      async pick() {
        const arguments_: JsonObject = { nested: { value: 'original' } }
        return {
          pick: 'a',
          arguments: arguments_,
          calls: [{ name: 'a', arguments: arguments_ }],
          text: '',
          callCount: 1,
          latencyMs: 2,
        }
      },
    }
    const cached = withCache(inner, createMemoryCache())

    const first = await cached.pick(request('mutable'))
    const firstProjectedNested = first.arguments?.['nested'] as JsonObject
    const firstCallNested = first.calls[0]?.arguments?.['nested'] as JsonObject
    firstProjectedNested['value'] = 'changed projection'
    firstCallNested['value'] = 'changed call'

    const second = await cached.pick(request('mutable'))
    expect(second.arguments).toEqual({ nested: { value: 'original' } })
    expect(second.calls[0]?.arguments).toEqual({ nested: { value: 'original' } })
    expect(second.arguments).not.toBe(second.calls[0]?.arguments)
  })
})

describe('the file cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'whichtool-cache-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('survives a round trip through disk', async () => {
    const cache = createFileCache(root, '.whichtool-cache')
    expect(await cache.get('deadbeef')).toBeNull()

    await cache.set('deadbeef', {
      pick: 'stale',
      arguments: { stale: true },
      rawArguments: 'stale',
      calls: [{ name: 'a', arguments: { q: 'x' } }],
      text: '',
      callCount: 99,
      originalLatencyMs: 12,
    })
    expect(await cache.get('deadbeef')).toMatchObject({
      pick: 'a',
      arguments: { q: 'x' },
      callCount: 1,
    })
    expect((await cache.get('deadbeef'))?.rawArguments).toBeUndefined()
  })

  test('treats syntactically valid but structurally corrupt files as misses', async () => {
    const corruptRoot = mkdtempSync(join(tmpdir(), 'whichtool-corrupt-cache-'))
    try {
      const cache = createFileCache(corruptRoot)
      await cache.set('badcafe', {
        pick: null,
        arguments: null,
        calls: 'not-an-array',
        text: '',
        callCount: 0,
        originalLatencyMs: 0,
      } as unknown as CachedPick)
      expect(await cache.get('badcafe')).toBeNull()
    } finally {
      rmSync(corruptRoot, { recursive: true, force: true })
    }
  })

  test('rejects an oversized sparse entry before reading or parsing its contents', async () => {
    const oversizedRoot = mkdtempSync(join(tmpdir(), 'whichtool-oversized-cache-'))
    try {
      const key = 'oversized'
      const shard = join(oversizedRoot, 'trials', key.slice(0, 2))
      const path = join(shard, `${key}.json`)
      mkdirSync(shard, { recursive: true })
      writeFileSync(path, '')
      truncateSync(path, MAX_CACHE_ENTRY_BYTES + 1)

      expect(await createFileCache(oversizedRoot).get(key)).toBeNull()
    } finally {
      rmSync(oversizedRoot, { recursive: true, force: true })
    }
  })

  test('reports what it holds and where', async () => {
    const cache = createFileCache(root, '.whichtool-cache')
    const info = await cache.info()
    expect(info.entries).toBe(1)
    expect(info.bytes).toBeGreaterThan(0)
    // The display location, never the absolute path: `cache info` output gets pasted.
    expect(info.location).toBe('.whichtool-cache')
  })

  test('clears and reports how many it removed', async () => {
    const cache = createFileCache(root, '.whichtool-cache')
    expect(await cache.clear()).toBe(1)
    expect((await cache.info()).entries).toBe(0)
    expect(await cache.get('deadbeef')).toBeNull()
  })

  test('an empty cache reports zero rather than failing', async () => {
    const cache = createFileCache(join(root, 'never-created'), 'x')
    expect(await cache.info()).toMatchObject({ entries: 0, bytes: 0 })
    expect(await cache.clear()).toBe(0)
  })
})
