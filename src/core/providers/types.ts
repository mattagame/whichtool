import { WhichtoolError } from '../errors.js'
import { isJsonObject } from '../json.js'
import type { JsonObject, NormalizedTool } from '../types.js'

export interface ProviderCapabilities {
  seed: boolean

  temperatureZero: boolean

  logprobs: boolean

  disableThinking: boolean
}

export interface PickRequest {
  tools: readonly NormalizedTool[]

  prompt: string
  temperature: number
  seed?: number | undefined
  signal?: AbortSignal | undefined
}

/** One tool call exactly as the provider exposed it, without executing it. */
export interface RecordedToolCall {
  /** Null only when a provider emitted a malformed call without a function/tool name. */
  name: string | null

  /** Parsed object arguments, or null when they were absent or could not be parsed. */
  arguments: JsonObject | null

  /** The original argument payload when it was not a JSON object. */
  rawArguments?: string
}

/** Hard ceiling for untrusted provider/report payloads. */
export const MAX_RECORDED_TOOL_CALLS = 1000

/** Normalize the argument encodings used by the supported provider APIs. */
export function recordToolCall(name: unknown, argumentPayload: unknown): RecordedToolCall {
  const call: RecordedToolCall = {
    name: typeof name === 'string' ? name : null,
    arguments: null,
  }
  if (typeof argumentPayload === 'string') {
    try {
      const parsed = JSON.parse(argumentPayload) as unknown
      if (isJsonObject(parsed)) call.arguments = parsed
      else call.rawArguments = argumentPayload
    } catch {
      call.rawArguments = argumentPayload
    }
  } else if (isJsonObject(argumentPayload)) {
    call.arguments = argumentPayload
  } else if (argumentPayload !== undefined && argumentPayload !== null) {
    call.rawArguments = JSON.stringify(argumentPayload) ?? String(argumentPayload)
  }
  return call
}

export interface PickResult {
  /** Compatibility projection of `calls[0]?.name`. */
  pick: string | null

  /** Compatibility projection of `calls[0]?.arguments`. */
  arguments: JsonObject | null

  /** Compatibility projection of `calls[0]?.rawArguments`. */
  rawArguments?: string

  /** Every tool call in provider order. No call is executed. */
  calls: RecordedToolCall[]

  text: string

  /** Compatibility count. Providers keep it equal to `calls.length`. */
  callCount: number
  latencyMs: number
  usage?: { promptTokens?: number; completionTokens?: number }

  reasoningChars?: number
}

export interface GenerateRequest {
  prompt: string
  temperature: number
  maxTokens?: number | undefined
  signal?: AbortSignal | undefined
}

export interface Provider {
  readonly id: string
  readonly model: string
  readonly capabilities: ProviderCapabilities

  readonly endpoint: string | null
  /**
   * Non-secret digest of request-construction options that can change the measured subject.
   * Null means the provider cannot describe those options completely.
   */
  readonly behaviorFingerprint?: (() => Promise<string | null>) | undefined
  /**
   * Opaque digest of construction options that can change a pick. `null` means the
   * provider is dynamic and must bypass persistent pick caching.
   */
  readonly cacheFingerprint?: (() => Promise<string | null>) | undefined
  pick(request: PickRequest): Promise<PickResult>

  generate?(request: GenerateRequest): Promise<string>
}

export class ProviderError extends WhichtoolError {
  readonly retryable: boolean
  readonly status: number | undefined

  constructor(message: string, options: { retryable: boolean; status?: number; hint?: string }) {
    super('provider/failed', message, options.hint)
    this.name = 'ProviderError'
    this.retryable = options.retryable
    this.status = options.status
  }
}

export function toOpenAiTool(tool: NormalizedTool): JsonObject {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,

      parameters: tool.inputSchema,
    },
  }
}
