import { isJsonObject } from '../json.js'
import type { JsonObject, JsonValue, NormalizedTool } from '../types.js'
import { urlForBehaviorFingerprint } from '../url-redaction.js'
import {
  createProviderBehaviorFingerprint,
  createProviderCacheFingerprint,
  reportableProviderHeaders,
} from './cache-fingerprint.js'
import { createJsonPoster, DEFAULT_RETRIES, stripCredentials } from './http.js'
import {
  ProviderError,
  recordToolCall,
  toOpenAiTool,
  type PickRequest,
  type PickResult,
  type Provider,
  type ProviderCapabilities,
} from './types.js'

export interface OpenAiCompatibleOptions {
  baseUrl: string
  model: string
  /** Sent as `Authorization: Bearer …`. Never recorded in a run, a log or a report. */
  apiKey?: string | undefined

  /**
   * Sent as `reasoning_effort`. Required as `none` for function tools on the gpt-5.6
   * family in chat completions; the endpoint answers 400 otherwise.
   */
  reasoningEffort?: string | undefined
  headers?: Record<string, string> | undefined
  fetch?: typeof fetch
  timeoutMs?: number
  retries?: number

  capabilities?: Partial<ProviderCapabilities>

  id?: string
}

function firstString(source: JsonObject, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function readCompletedChatTurn(
  payload: JsonObject,
  endpoint: string,
): { message: JsonObject; calls: ReturnType<typeof recordToolCall>[] } {
  const choices = payload['choices']
  const choice = Array.isArray(choices) && isJsonObject(choices[0]) ? choices[0] : null
  if (choice === null) {
    throw new ProviderError(`${endpoint} returned no choices`, { retryable: false })
  }

  const finishReason = choice['finish_reason']
  // A turn cut off at the token limit is not the model declining to call a tool. Left
  // unread, it scores as an abstention and moves the over-trigger rate for a reason
  // that has nothing to do with the surface.
  if (finishReason === 'length') {
    throw new ProviderError(`${endpoint} stopped at the token limit before the turn finished.`, {
      retryable: false,
      hint: 'Raise the completion token budget rather than letting a truncated turn score as an abstention. On a reasoning model the reasoning tokens count against the same budget.',
    })
  }
  if (finishReason === 'content_filter') {
    throw new ProviderError(`${endpoint} filtered the response instead of completing the turn.`, {
      retryable: false,
      hint: 'A filtered response is not an abstention and is excluded from scoring.',
    })
  }
  if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
    const detail = typeof finishReason === 'string' ? finishReason : 'missing finish_reason'
    throw new ProviderError(`${endpoint} returned a non-completed chat turn (${detail}).`, {
      retryable: false,
      hint: 'A malformed or non-completed provider response is not an abstention and is excluded from scoring.',
    })
  }

  const message = isJsonObject(choice['message']) ? choice['message'] : null
  if (message === null) {
    throw new ProviderError(`${endpoint} returned a completed choice without a message.`, {
      retryable: false,
    })
  }
  const content = message['content']
  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw new ProviderError(`${endpoint} returned malformed message content.`, {
      retryable: false,
    })
  }

  const refusal = message['refusal']
  if (typeof refusal === 'string' && refusal.trim() !== '') {
    throw new ProviderError(`${endpoint} declined the request.`, {
      retryable: false,
      hint: 'A refusal is not an abstention and is excluded from scoring.',
    })
  }
  if (refusal !== undefined && refusal !== null && typeof refusal !== 'string') {
    throw new ProviderError(`${endpoint} returned a malformed refusal field.`, {
      retryable: false,
    })
  }

  const rawCalls = message['tool_calls']
  if (rawCalls !== undefined && rawCalls !== null && !Array.isArray(rawCalls)) {
    throw new ProviderError(`${endpoint} returned malformed tool_calls.`, { retryable: false })
  }
  const calls = rawCalls ?? []
  if (!Array.isArray(calls) || calls.some((call) => !isJsonObject(call))) {
    throw new ProviderError(`${endpoint} returned a malformed tool call.`, { retryable: false })
  }
  const recordedCalls = (calls as JsonObject[]).map((call) => {
    const fn = isJsonObject(call['function']) ? call['function'] : null
    if (fn === null) {
      throw new ProviderError(`${endpoint} returned a tool call without a function envelope.`, {
        retryable: false,
      })
    }
    return recordToolCall(fn['name'], fn['arguments'])
  })

  if (finishReason === 'tool_calls' && recordedCalls.length === 0) {
    throw new ProviderError(`${endpoint} finished for tool calls but returned none.`, {
      retryable: false,
    })
  }
  if (finishReason === 'stop' && recordedCalls.length > 0) {
    throw new ProviderError(`${endpoint} returned tool calls with an inconsistent finish_reason.`, {
      retryable: false,
    })
  }

  return { message, calls: recordedCalls }
}

/**
 * OpenAI constrains a function name to `a-z A-Z 0-9 _ -`, at most 64 characters. MCP
 * surfaces routinely ship dotted or namespaced names, and the endpoint answers 400 without
 * naming the tool. Only the hint is added — the name is never rewritten, because a run has
 * to measure the surface as served rather than a sanitized copy of it.
 */
const OPENAI_FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/

function explainRejectedNames(cause: unknown, tools: readonly NormalizedTool[]): unknown {
  if (!(cause instanceof ProviderError) || cause.status !== 400) return cause
  if (cause.message.includes('reasoning_effort')) {
    return new ProviderError(cause.message, {
      retryable: false,
      status: 400,
      hint: 'This model rejects function tools unless reasoning is off on this endpoint. Pass --reasoning-effort none, and read the result as the model with reasoning disabled, which the report records.',
    })
  }
  const offending = tools
    .map((tool) => tool.name)
    .filter((name) => !OPENAI_FUNCTION_NAME.test(name))
  if (offending.length === 0) return cause
  return new ProviderError(cause.message, {
    retryable: false,
    status: 400,
    hint: `${offending.length} tool name(s) fall outside what an OpenAI function name allows (a-z, A-Z, 0-9, underscore, dash; 64 characters): ${offending.join(', ')}. That surface cannot be measured on this provider as served.`,
  })
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): Provider {
  const base = options.baseUrl.replace(/\/+$/, '')
  const endpoint = `${base}/chat/completions`
  const safeEndpoint = stripCredentials(endpoint)

  const capabilities: ProviderCapabilities = {
    seed: true,
    temperatureZero: true,
    logprobs: false,
    disableThinking: false,
    ...options.capabilities,
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...options.headers,
  }
  if (options.apiKey !== undefined && options.apiKey !== '') {
    headers['authorization'] = `Bearer ${options.apiKey}`
  }
  const retries = options.retries ?? DEFAULT_RETRIES
  const cacheFingerprint = createProviderCacheFingerprint({
    api: 'openai-chat-completions/v1',
    id: options.id ?? 'openai-compatible',
    model: options.model,
    endpoint,
    headers,
    reasoningEffort: options.reasoningEffort ?? null,
    timeoutMs: options.timeoutMs ?? null,
    retries,
    capabilities,
  })
  const behaviorFingerprint = createProviderBehaviorFingerprint({
    api: 'openai-chat-completions/v1',
    id: options.id ?? 'openai-compatible',
    model: options.model,
    endpoint: urlForBehaviorFingerprint(endpoint),
    headers: reportableProviderHeaders(headers),
    reasoningEffort: options.reasoningEffort ?? null,
    timeoutMs: options.timeoutMs ?? null,
    retries,
    capabilities,
  })

  const request = createJsonPoster({
    endpoint,
    headers,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    retries,
  })
  return {
    id: options.id ?? 'openai-compatible',
    model: options.model,
    endpoint: safeEndpoint,
    capabilities,
    behaviorFingerprint,
    cacheFingerprint,

    async pick(pickRequest: PickRequest): Promise<PickResult> {
      const body: JsonObject = {
        model: options.model,
        // The bare prompt, with no system message and no examples. Adding context here
        // would mean measuring whichtool's prompt instead of the server's surface.
        messages: [{ role: 'user', content: pickRequest.prompt }],
        tools: pickRequest.tools.map(toOpenAiTool) as unknown as JsonValue,
        temperature: pickRequest.temperature,
        ...(options.reasoningEffort !== undefined
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
        // `tool_choice` is deliberately left unset, which means "auto". Forcing a call
        // would make abstention impossible and destroy both the abstention and the
        // over-trigger metrics.
      }
      if (pickRequest.seed !== undefined && capabilities.seed) body['seed'] = pickRequest.seed

      const started = Date.now()
      let payload: JsonObject
      try {
        payload = await request(body, pickRequest.signal)
      } catch (cause) {
        throw explainRejectedNames(cause, pickRequest.tools)
      }
      const latencyMs = Date.now() - started

      const { message, calls: recordedCalls } = readCompletedChatTurn(payload, safeEndpoint)

      const result: PickResult = {
        pick: null,
        arguments: null,
        calls: recordedCalls,
        text: firstString(message, ['content']),
        callCount: recordedCalls.length,
        latencyMs,
      }

      const reasoning = firstString(message, ['reasoning', 'reasoning_content'])
      if (reasoning !== '') result.reasoningChars = reasoning.length

      const usage = payload['usage']
      if (isJsonObject(usage)) {
        const prompt = usage['prompt_tokens']
        const completion = usage['completion_tokens']
        result.usage = {
          ...(typeof prompt === 'number' ? { promptTokens: prompt } : {}),
          ...(typeof completion === 'number' ? { completionTokens: completion } : {}),
        }
      }

      // Compatibility fields remain a projection of the first call. `calls` above keeps
      // the complete ordered proposal for scoring and machine consumers.
      const first = recordedCalls[0]
      if (first !== undefined) {
        result.pick = first.name
        result.arguments = first.arguments
        if (first.rawArguments !== undefined) result.rawArguments = first.rawArguments
      }

      return result
    },

    async generate(generateRequest): Promise<string> {
      const body: JsonObject = {
        model: options.model,
        messages: [{ role: 'user', content: generateRequest.prompt }],
        temperature: generateRequest.temperature,
      }
      if (generateRequest.maxTokens !== undefined) {
        body['max_tokens'] = generateRequest.maxTokens
      }

      const payload = await request(body, generateRequest.signal)
      const { message, calls } = readCompletedChatTurn(payload, safeEndpoint)
      if (calls.length > 0) {
        throw new ProviderError(`${safeEndpoint} returned tool calls instead of generated text.`, {
          retryable: false,
        })
      }
      return firstString(message, ['content'])
    },
  }
}

/**
 * Ollama, preconfigured.
 *
 * Ollama exposes an OpenAI-compatible endpoint at `/v1`, so this is the generic provider
 * with the local defaults filled in and no API key.
 *
 * The capabilities are declared as measured, not as hoped. Against qwen3:4b on 2026-08-17
 * temperature 0 produced byte-identical generations across repeated calls, and no documented
 * knob reduced the reasoning tokens of a thinking model.
 */
export function createOllamaProvider(
  options: Omit<OpenAiCompatibleOptions, 'baseUrl'> & { baseUrl?: string },
): Provider {
  const { baseUrl, ...rest } = options
  return createOpenAiCompatibleProvider({
    id: 'ollama',
    baseUrl: baseUrl ?? 'http://127.0.0.1:11434/v1',
    ...rest,
    capabilities: {
      seed: true,
      temperatureZero: true,
      logprobs: false,
      disableThinking: false,
      ...rest.capabilities,
    },
  })
}
