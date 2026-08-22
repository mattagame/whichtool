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

export interface OpenAiResponsesOptions {
  baseUrl: string
  model: string
  /** Sent as `Authorization: Bearer ...`. Never recorded in a report. */
  apiKey?: string | undefined
  reasoningEffort?: string | undefined
  headers?: Record<string, string> | undefined
  fetch?: typeof fetch
  timeoutMs?: number
  retries?: number
  capabilities?: Partial<ProviderCapabilities>
  id?: string
}

function toResponsesTool(tool: NormalizedTool): JsonObject {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }
}

function assertCompleted(payload: JsonObject, endpoint: string): void {
  const status = payload['status']
  if (status === 'completed') return

  const error = isJsonObject(payload['error']) ? payload['error'] : {}
  const incomplete = isJsonObject(payload['incomplete_details'])
    ? payload['incomplete_details']
    : {}
  const detail =
    (typeof error['message'] === 'string' && error['message']) ||
    (typeof incomplete['reason'] === 'string' && incomplete['reason']) ||
    (status === undefined ? 'missing status' : String(status))
  throw new ProviderError(`${endpoint} returned an incomplete response: ${detail}`, {
    retryable: false,
    hint: 'An incomplete or failed response is not an abstention and is excluded from scoring.',
  })
}

function readOutput(
  payload: JsonObject,
  endpoint: string,
): {
  calls: ReturnType<typeof recordToolCall>[]
  text: string
} {
  const rawOutput = payload['output']
  if (!Array.isArray(rawOutput) || rawOutput.length === 0) {
    throw new ProviderError(`${endpoint} returned no output items.`, { retryable: false })
  }
  if (rawOutput.some((item) => !isJsonObject(item))) {
    throw new ProviderError(`${endpoint} returned a malformed output item.`, { retryable: false })
  }

  const items = rawOutput as JsonObject[]
  const calls: ReturnType<typeof recordToolCall>[] = []
  const text: string[] = []
  let terminalItems = 0

  for (const item of items) {
    const itemStatus = item['status']
    if (itemStatus !== undefined && itemStatus !== 'completed') {
      throw new ProviderError(
        `${endpoint} returned a non-completed ${String(item['type'] ?? 'output')} item (${String(itemStatus)}).`,
        {
          retryable: false,
          hint: 'A non-completed output item is not an abstention and is excluded from scoring.',
        },
      )
    }

    if (item['type'] === 'function_call') {
      terminalItems += 1
      calls.push(recordToolCall(item['name'], item['arguments']))
      continue
    }
    if (item['type'] !== 'message') continue

    terminalItems += 1
    const content = item['content']
    if (!Array.isArray(content) || content.some((part) => !isJsonObject(part))) {
      throw new ProviderError(`${endpoint} returned malformed message content.`, {
        retryable: false,
      })
    }
    for (const part of content as JsonObject[]) {
      if (part['type'] === 'refusal') {
        throw new ProviderError(`${endpoint} declined the request.`, {
          retryable: false,
          hint: 'A refusal is not an abstention and is excluded from scoring.',
        })
      }
      if (part['type'] !== 'output_text') continue
      if (typeof part['text'] !== 'string') {
        throw new ProviderError(`${endpoint} returned output_text without text.`, {
          retryable: false,
        })
      }
      text.push(part['text'])
    }
  }

  if (terminalItems === 0) {
    throw new ProviderError(`${endpoint} returned no terminal output item.`, {
      retryable: false,
    })
  }
  return { calls, text: text.join('') }
}

/**
 * Native OpenAI Responses API provider.
 *
 * The tool representation and response envelope intentionally do not share the Chat
 * Completions parser. Keeping the two APIs separate makes the recorded endpoint an honest
 * part of the measured harness and prevents a future change in one wire format from
 * silently changing the other.
 */
export function createOpenAiResponsesProvider(options: OpenAiResponsesOptions): Provider {
  const base = options.baseUrl.replace(/\/+$/, '')
  const endpoint = `${base}/responses`
  const safeEndpoint = stripCredentials(endpoint)
  const capabilities: ProviderCapabilities = {
    seed: false,
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
    api: 'openai-responses/v1',
    id: options.id ?? 'openai',
    model: options.model,
    endpoint,
    headers,
    reasoningEffort: options.reasoningEffort ?? null,
    timeoutMs: options.timeoutMs ?? null,
    retries,
    capabilities,
  })
  const behaviorFingerprint = createProviderBehaviorFingerprint({
    api: 'openai-responses/v1',
    id: options.id ?? 'openai',
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

  const commonBody = (): JsonObject => ({
    model: options.model,
    store: false,
    ...(options.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: options.reasoningEffort } }),
  })

  return {
    id: options.id ?? 'openai',
    model: options.model,
    endpoint: safeEndpoint,
    capabilities,
    behaviorFingerprint,
    cacheFingerprint,

    async pick(pickRequest: PickRequest): Promise<PickResult> {
      const body: JsonObject = {
        ...commonBody(),
        input: pickRequest.prompt,
        tools: pickRequest.tools.map(toResponsesTool) as unknown as JsonValue,
        tool_choice: 'auto',
        temperature: pickRequest.temperature,
      }

      const started = Date.now()
      const payload = await request(body, pickRequest.signal)
      const latencyMs = Date.now() - started
      assertCompleted(payload, safeEndpoint)

      const { calls: recordedCalls, text } = readOutput(payload, safeEndpoint)
      const result: PickResult = {
        pick: null,
        arguments: null,
        calls: recordedCalls,
        text,
        callCount: recordedCalls.length,
        latencyMs,
      }

      const usage = payload['usage']
      if (isJsonObject(usage)) {
        const input = usage['input_tokens']
        const output = usage['output_tokens']
        result.usage = {
          ...(typeof input === 'number' ? { promptTokens: input } : {}),
          ...(typeof output === 'number' ? { completionTokens: output } : {}),
        }
      }

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
        ...commonBody(),
        input: generateRequest.prompt,
        temperature: generateRequest.temperature,
        ...(generateRequest.maxTokens === undefined
          ? {}
          : { max_output_tokens: generateRequest.maxTokens }),
      }
      const payload = await request(body, generateRequest.signal)
      assertCompleted(payload, safeEndpoint)
      const { calls, text } = readOutput(payload, safeEndpoint)
      if (calls.length > 0) {
        throw new ProviderError(`${safeEndpoint} returned tool calls instead of generated text.`, {
          retryable: false,
        })
      }
      if (text === '') {
        throw new ProviderError(`${safeEndpoint} returned no output text`, { retryable: false })
      }
      return text
    },
  }
}
