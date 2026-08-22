import type { JsonObject, JsonValue } from '../types.js'
import {
  createProviderCacheFingerprint,
  uncacheableProviderFingerprint,
} from './cache-fingerprint.js'
import {
  ProviderError,
  type PickRequest,
  type PickResult,
  type Provider,
  type RecordedToolCall,
} from './types.js'

export interface ScriptedPick {
  pick: string | null
  arguments?: JsonObject | null
  rawArguments?: string
  /** Complete ordered calls. When present, these are authoritative over compatibility fields. */
  calls?: readonly RecordedToolCall[]
  text?: string
  /** @deprecated Prefer `calls`; retained for old mock scripts that only asserted a count. */
  callCount?: number

  error?: { message: string; retryable: boolean }
  latencyMs?: number
}

export type MockScript =
  ScriptedPick[] | ((request: PickRequest, callIndex: number) => ScriptedPick)

export interface MockProviderOptions {
  model?: string
  script: MockScript

  cycle?: boolean

  generate?: string | ((prompt: string) => string)
  /** Stable identity for a function-valued script; omit it to bypass persistent caching. */
  cacheKey?: JsonValue
}

export interface MockProvider extends Provider {
  readonly calls: PickRequest[]
}

export function createMockProvider(options: MockProviderOptions): MockProvider {
  const providerRequests: PickRequest[] = []
  let index = 0

  const generate =
    options.generate === undefined
      ? undefined
      : async (request: { prompt: string }): Promise<string> =>
          typeof options.generate === 'function'
            ? options.generate(request.prompt)
            : (options.generate as string)
  const cacheFingerprint =
    typeof options.script === 'function' && options.cacheKey === undefined
      ? uncacheableProviderFingerprint
      : createProviderCacheFingerprint({
          provider: 'mock/v1',
          model: options.model ?? 'mock-1',
          script: options.cacheKey ?? options.script,
          cycle: options.cycle ?? false,
        })

  return {
    id: 'mock',
    model: options.model ?? 'mock-1',
    endpoint: null,
    capabilities: { seed: true, temperatureZero: true, logprobs: false, disableThinking: true },
    behaviorFingerprint: uncacheableProviderFingerprint,
    cacheFingerprint,
    calls: providerRequests,
    ...(generate === undefined ? {} : { generate }),
    async pick(request: PickRequest): Promise<PickResult> {
      providerRequests.push(request)
      const callIndex = index
      index += 1

      const scripted =
        typeof options.script === 'function'
          ? options.script(request, callIndex)
          : options.script[options.cycle === true ? callIndex % options.script.length : callIndex]

      if (scripted === undefined) {
        throw new ProviderError(`the mock provider ran out of script at call ${callIndex}`, {
          retryable: false,
        })
      }
      if (scripted.error !== undefined) {
        throw new ProviderError(scripted.error.message, { retryable: scripted.error.retryable })
      }

      const resultCalls: RecordedToolCall[] =
        scripted.calls === undefined
          ? scripted.pick === null
            ? []
            : [
                {
                  name: scripted.pick,
                  arguments: scripted.arguments ?? null,
                  ...(scripted.rawArguments === undefined
                    ? {}
                    : { rawArguments: scripted.rawArguments }),
                },
              ]
          : scripted.calls.map((call) => ({ ...call }))
      // Older mock scripts could declare only `callCount`. Preserve that fact without
      // inventing a name or arguments for calls the script never described.
      const legacyCount = Math.max(resultCalls.length, scripted.callCount ?? resultCalls.length)
      while (resultCalls.length < legacyCount) {
        resultCalls.push({ name: null, arguments: null })
      }
      const first = resultCalls[0]
      const result: PickResult = {
        pick: first?.name ?? null,
        arguments: first?.arguments ?? null,
        calls: resultCalls,
        text: scripted.text ?? '',
        callCount: resultCalls.length,
        latencyMs: scripted.latencyMs ?? 0,
      }
      if (first?.rawArguments !== undefined) result.rawArguments = first.rawArguments
      return result
    },
  }
}

/**
 * A mock that answers by keyword, so a test can describe behaviour instead of enumerating
 * every trial: `{ rossi: "search_users" }` picks `search_users` for any prompt containing
 * "rossi". Anything unmatched abstains.
 */
export function createKeywordProvider(
  rules: Record<string, string>,
  options: { model?: string; argumentsFor?: (pick: string) => JsonObject | null } = {},
): MockProvider {
  return createMockProvider({
    ...(options.model === undefined ? {} : { model: options.model }),
    script: (request) => {
      const prompt = request.prompt.toLowerCase()
      for (const [keyword, pick] of Object.entries(rules)) {
        if (!prompt.includes(keyword.toLowerCase())) continue
        return { pick, arguments: options.argumentsFor?.(pick) ?? null }
      }
      return { pick: null, text: 'I cannot help with that.' }
    },
    ...(options.argumentsFor === undefined ? { cacheKey: { provider: 'keyword/v1', rules } } : {}),
  })
}
