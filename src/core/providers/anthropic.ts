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
  type GenerateRequest,
  type PickRequest,
  type PickResult,
  type Provider,
  type ProviderCapabilities,
} from './types.js'

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'

/**
 * Enough room for the tool call and for the thinking that precedes it. `max_tokens` caps
 * thinking and response text together, and thinking is on by default on current Claude
 * models, so a budget sized for a bare tool call truncates the turn instead.
 */
const DEFAULT_MAX_TOKENS = 8192

export interface AnthropicOptions {
  model: string
  /** Sent as `x-api-key`. Never recorded in a run, a log or a report. */
  apiKey?: string | undefined

  baseUrl?: string
  maxTokens?: number
  fetch?: typeof fetch
  timeoutMs?: number
  retries?: number
}

/**
 * The Anthropic tool shape is flat: `name`, `description`, `input_schema`. It is not the
 * OpenAI `{ type: 'function', function: { … } }` envelope, so `toOpenAiTool` does not apply
 * here (SPEC section 12: read each provider's parameters rather than assume symmetry).
 */
function toAnthropicTool(tool: NormalizedTool): JsonObject {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

function textOf(blocks: readonly JsonObject[]): string {
  return blocks
    .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => block['text'] as string)
    .join('')
}

/**
 * Claude via the Messages API.
 *
 * Three things differ from an OpenAI-compatible endpoint in ways that would corrupt a
 * measurement rather than fail it, so each is handled deliberately:
 *
 * 1. **No sampling parameters.** `temperature`, `top_p` and `top_k` were removed on current
 *    Claude models and are answered with HTTP 400. Nothing is sent, and the provider
 *    declares `temperatureZero: false` so a run says plainly that it read intervals rather
 *    than a temperature it never applied.
 * 2. **Thinking stays on.** It is on by default, and disabling it is documented to make the
 *    model occasionally write a tool call as ordinary text instead of emitting a `tool_use`
 *    block. That turn succeeds, so whichtool would score a deliberate pick as an
 *    abstention: a wrong number rather than a visible failure. Paying for the thinking
 *    tokens is the cheaper of the two.
 * 3. **A refusal is HTTP 200.** `stop_reason: "refusal"` is neither a pick nor an
 *    abstention, and neither is a turn truncated at `max_tokens`. Both are raised as errors
 *    so the trial is excluded from every rate instead of quietly moving one.
 */
export function createAnthropicProvider(options: AnthropicOptions): Provider {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const endpoint = `${base}/v1/messages`
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS

  const capabilities: ProviderCapabilities = {
    // No seed parameter exists on the Messages API.
    seed: false,
    // Temperature cannot be sent at all, so temperature 0 is not honoured. The run report
    // says so rather than recording a setting that never reached the model.
    temperatureZero: false,
    logprobs: false,
    // Technically possible, deliberately not done — see the note above.
    disableThinking: false,
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': API_VERSION,
  }
  if (options.apiKey !== undefined && options.apiKey !== '') {
    headers['x-api-key'] = options.apiKey
  }
  const retries = options.retries ?? DEFAULT_RETRIES
  const cacheFingerprint = createProviderCacheFingerprint({
    api: `anthropic-messages/${API_VERSION}`,
    model: options.model,
    endpoint,
    headers,
    maxTokens,
    timeoutMs: options.timeoutMs ?? null,
    retries,
    capabilities,
  })
  const behaviorFingerprint = createProviderBehaviorFingerprint({
    api: `anthropic-messages/${API_VERSION}`,
    model: options.model,
    endpoint: urlForBehaviorFingerprint(endpoint),
    headers: reportableProviderHeaders(headers),
    maxTokens,
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

  const safeEndpoint = stripCredentials(endpoint)

  const readUsableTurn = (payload: JsonObject): JsonObject[] => {
    const stopReason = payload['stop_reason']

    if (stopReason === 'refusal') {
      const details = isJsonObject(payload['stop_details']) ? payload['stop_details'] : {}
      const category = typeof details['category'] === 'string' ? details['category'] : 'unstated'
      throw new ProviderError(`${safeEndpoint} declined the request (category: ${category}).`, {
        retryable: false,
        hint: 'A refusal is not the model abstaining, so the trial is excluded rather than counted as one. Safety classifiers can fire on benign security or life-sciences wording; rephrase the task prompt or measure that surface on another provider.',
      })
    }

    if (stopReason === 'max_tokens') {
      throw new ProviderError(
        `${safeEndpoint} stopped at max_tokens (${maxTokens}) before the turn finished.`,
        {
          retryable: false,
          hint: 'Thinking and the reply share this budget on current Claude models. Raise the provider max-tokens rather than letting a truncated turn score as an abstention.',
        },
      )
    }

    if (stopReason !== 'end_turn' && stopReason !== 'stop_sequence' && stopReason !== 'tool_use') {
      const detail = typeof stopReason === 'string' ? stopReason : 'missing stop_reason'
      throw new ProviderError(`${safeEndpoint} returned a non-completed turn (${detail}).`, {
        retryable: false,
        hint: 'A malformed or paused provider response is not an abstention and is excluded from scoring.',
      })
    }

    const content = payload['content']
    if (!Array.isArray(content) || content.length === 0) {
      throw new ProviderError(`${safeEndpoint} returned no content blocks`, { retryable: false })
    }
    if (content.some((block) => !isJsonObject(block))) {
      throw new ProviderError(`${safeEndpoint} returned a malformed content block`, {
        retryable: false,
      })
    }

    const blocks = content as JsonObject[]
    let terminalBlocks = 0
    for (const block of blocks) {
      if (block['type'] === 'text') {
        terminalBlocks += 1
        if (typeof block['text'] !== 'string') {
          throw new ProviderError(`${safeEndpoint} returned a text block without text`, {
            retryable: false,
          })
        }
      } else if (block['type'] === 'tool_use') {
        terminalBlocks += 1
      }
    }
    if (terminalBlocks === 0) {
      throw new ProviderError(`${safeEndpoint} returned no terminal content block`, {
        retryable: false,
      })
    }
    const toolCalls = blocks.filter((block) => block['type'] === 'tool_use')
    if (stopReason === 'tool_use' && toolCalls.length === 0) {
      throw new ProviderError(
        `${safeEndpoint} stopped for tool use but returned no tool_use block`,
        {
          retryable: false,
        },
      )
    }
    if (stopReason !== 'tool_use' && toolCalls.length > 0) {
      throw new ProviderError(
        `${safeEndpoint} returned tool_use with an inconsistent stop_reason`,
        {
          retryable: false,
        },
      )
    }
    return blocks
  }

  return {
    id: 'anthropic',
    model: options.model,
    endpoint: safeEndpoint,
    capabilities,
    behaviorFingerprint,
    cacheFingerprint,

    async pick(pickRequest: PickRequest): Promise<PickResult> {
      const body: JsonObject = {
        model: options.model,
        max_tokens: maxTokens,
        // The bare prompt, with no system message and no examples. Adding context here
        // would mean measuring whichtool's prompt instead of the server's surface.
        messages: [{ role: 'user', content: pickRequest.prompt }],
        tools: pickRequest.tools.map(toAnthropicTool) as unknown as JsonValue,
        // `tool_choice` is deliberately left unset, which means "auto". Forcing a call
        // would make abstention impossible and destroy both the abstention and the
        // over-trigger metrics. `disable_parallel_tool_use` is left unset for the same
        // reason the OpenAI path allows several calls: reaching for more than one tool is
        // a fact about the surface, and `callCount` records it.
      }

      const started = Date.now()
      const payload = await request(body, pickRequest.signal)
      const latencyMs = Date.now() - started

      const blocks = readUsableTurn(payload)

      const calls = blocks.filter((block) => block['type'] === 'tool_use')
      const recordedCalls = calls.map((call) => recordToolCall(call['name'], call['input']))

      const result: PickResult = {
        pick: null,
        arguments: null,
        calls: recordedCalls,
        text: textOf(blocks),
        callCount: recordedCalls.length,
        latencyMs,
      }

      // No `reasoningChars`: thinking blocks carry an empty string unless
      // `display: "summarized"` is requested, which whichtool has no use for. Output tokens
      // below are the honest cost signal for a thinking model.
      const usage = payload['usage']
      if (isJsonObject(usage)) {
        const prompt = usage['input_tokens']
        const completion = usage['output_tokens']
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

    async generate(generateRequest: GenerateRequest): Promise<string> {
      const body: JsonObject = {
        model: options.model,
        max_tokens: generateRequest.maxTokens ?? maxTokens,
        messages: [{ role: 'user', content: generateRequest.prompt }],
      }

      const payload = await request(body, generateRequest.signal)
      const blocks = readUsableTurn(payload)
      if (blocks.some((block) => block['type'] === 'tool_use')) {
        throw new ProviderError(`${safeEndpoint} returned tool use instead of generated text.`, {
          retryable: false,
        })
      }
      const text = textOf(blocks)
      if (text === '') {
        throw new ProviderError(`${safeEndpoint} returned no generated text.`, { retryable: false })
      }
      return text
    },
  }
}
