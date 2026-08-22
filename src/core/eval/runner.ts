import {
  MAX_RECORDED_TOOL_CALLS,
  ProviderError,
  type Provider,
  type RecordedToolCall,
} from '../providers/types.js'
import { WhichtoolError } from '../errors.js'
import { isJsonObject } from '../json.js'
import type { Task } from '../tasks/schema.js'
import type { JsonObject, JsonValue, NormalizedTool } from '../types.js'
import {
  ABSOLUTE_MAX_TOOLS,
  ABSOLUTE_MAX_TRIALS,
  assertConcurrency,
  assertMaxTools,
  assertMaxTrials,
  assertTemperature,
} from './options.js'
import { orderTools, type Trial, type TrialPlan } from './planner.js'

export interface TrialOutcome {
  taskId: string
  trialIndex: number
  expected: string | null

  pick: string | null
  arguments: JsonObject | null
  rawArguments?: string
  /** Every tool call proposed by the model, in provider order. None was executed. */
  calls: RecordedToolCall[]
  text: string
  callCount: number

  order: string[]
  expectedPosition: number
  latencyMs: number
  usage?: { promptTokens?: number; completionTokens?: number }
  reasoningChars?: number

  /** `hint` carries the actionable half; without it a failed run says only that it failed. */
  error?: { message: string; retryable: boolean; hint?: string }
}

export interface RunnerOptions {
  concurrency?: number
  /** Defensive execution ceiling. Defaults to the absolute library maximum. */
  maxTrials?: number
  /** Defensive tool-surface ceiling. Defaults to the absolute library maximum. */
  maxTools?: number
  temperature?: number
  signal?: AbortSignal | undefined
  onTrial?: (outcome: TrialOutcome, completed: number, total: number) => void
}

export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_TEMPERATURE = 0

export interface RunnerResult {
  outcomes: TrialOutcome[]

  durationMs: number

  cancelled: boolean
}

const INVALID_JSON = Symbol('invalid-json')

// AbortSignal.aborted is typed readonly even though it changes asynchronously. Reading it
// through a function prevents TypeScript from treating the pre-await value as permanent.
function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

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
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return INVALID_JSON
      const copied = cloneJsonValueStrict(value[index], ancestors)
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

function malformedCall(index: number, detail: string): never {
  throw new ProviderError(`Provider returned malformed tool call #${index + 1}: ${detail}.`, {
    retryable: false,
  })
}

function normalizeProviderCalls(value: unknown): RecordedToolCall[] {
  try {
    if (!Array.isArray(value)) {
      throw new ProviderError('Provider returned malformed calls: expected an array.', {
        retryable: false,
      })
    }
    if (value.length > MAX_RECORDED_TOOL_CALLS) {
      throw new ProviderError(
        `Provider proposed ${value.length} calls in one turn; the safety limit is ${MAX_RECORDED_TOOL_CALLS}.`,
        { retryable: false },
      )
    }

    const calls: RecordedToolCall[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        malformedCall(index, 'sparse call arrays are not valid')
      }
      const rawCall: unknown = value[index]
      if (!isJsonObject(rawCall)) malformedCall(index, 'expected an object')
      const prototype = Object.getPrototypeOf(rawCall)
      if (prototype !== Object.prototype && prototype !== null) {
        malformedCall(index, 'expected a plain object')
      }

      const name = rawCall['name']
      if (name !== null && typeof name !== 'string') {
        malformedCall(index, 'name must be a string or null')
      }

      const rawArguments = rawCall['arguments']
      let arguments_: JsonObject | null = null
      if (rawArguments !== null) {
        const copied = cloneJsonValueStrict(rawArguments)
        if (copied === INVALID_JSON || !isJsonObject(copied)) {
          malformedCall(index, 'arguments must be a finite JSON object or null')
        }
        arguments_ = copied
      }

      const call: RecordedToolCall = { name, arguments: arguments_ }
      if (Object.prototype.hasOwnProperty.call(rawCall, 'rawArguments')) {
        const raw = rawCall['rawArguments']
        if (typeof raw !== 'string') malformedCall(index, 'rawArguments must be a string')
        call.rawArguments = raw
      }
      calls.push(call)
    }
    return calls
  } catch (cause) {
    if (cause instanceof ProviderError) throw cause
    throw new ProviderError('Provider returned malformed tool calls that could not be read.', {
      retryable: false,
    })
  }
}

async function runOne(
  trial: Trial,
  task: Task,
  tools: readonly NormalizedTool[],
  provider: Provider,
  options: RunnerOptions,
): Promise<TrialOutcome> {
  const base: TrialOutcome = {
    taskId: trial.taskId,
    trialIndex: trial.trialIndex,
    expected: task.expected,
    pick: null,
    arguments: null,
    calls: [],
    text: '',
    callCount: 0,
    order: trial.order,
    expectedPosition: trial.expectedPosition,
    latencyMs: 0,
  }

  try {
    const result = await provider.pick({
      tools: orderTools(tools, trial.order),
      prompt: task.prompt,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,

      seed: trial.seed,
      signal: options.signal,
    })

    const calls = normalizeProviderCalls(result.calls)
    const first = calls[0]
    const outcome: TrialOutcome = {
      ...base,
      // `calls` is the authoritative provider result. Keep the old scalar fields as an
      // exact projection even for third-party Provider implementations.
      pick: first?.name ?? null,
      arguments: first?.arguments ?? null,
      calls,
      text: result.text,
      callCount: calls.length,
      latencyMs: result.latencyMs,
    }
    if (first?.rawArguments !== undefined) outcome.rawArguments = first.rawArguments
    if (result.usage !== undefined) outcome.usage = result.usage
    if (result.reasoningChars !== undefined) outcome.reasoningChars = result.reasoningChars
    return outcome
  } catch (cause) {
    return {
      ...base,
      error: {
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: cause instanceof ProviderError ? cause.retryable : false,
        ...(cause instanceof ProviderError && cause.hint !== undefined ? { hint: cause.hint } : {}),
      },
    }
  }
}

export async function runTrials(
  plan: TrialPlan,
  tasks: readonly Task[],
  tools: readonly NormalizedTool[],
  provider: Provider,
  options: RunnerOptions = {},
): Promise<RunnerResult> {
  if (plan.trials.length === 0) {
    throw new WhichtoolError(
      'trials/empty-plan',
      'Cannot execute a trial plan containing zero trials.',
    )
  }

  const byId = new Map(tasks.map((task) => [task.id, task]))
  const outcomes = new Array<TrialOutcome>(plan.trials.length)
  const maxTrials = assertMaxTrials(options.maxTrials ?? ABSOLUTE_MAX_TRIALS)
  if (plan.trials.length > maxTrials) {
    throw new WhichtoolError(
      'trials/limit-exceeded',
      `Run contains ${plan.trials.length} trials; the execution limit is ${maxTrials}.`,
    )
  }
  const maxTools = assertMaxTools(options.maxTools ?? ABSOLUTE_MAX_TOOLS)
  if (tools.length > maxTools || plan.toolCount > maxTools) {
    throw new WhichtoolError(
      'trials/tool-limit-exceeded',
      `Run contains ${Math.max(tools.length, plan.toolCount)} tools; the execution limit is ${maxTools}.`,
    )
  }
  const concurrency = assertConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY)
  assertTemperature(options.temperature ?? DEFAULT_TEMPERATURE)
  const started = Date.now()

  let cursor = 0
  let completed = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (isAbortRequested(options.signal)) return

      const index = cursor
      cursor += 1
      if (index >= plan.trials.length) return

      const trial = plan.trials[index] as Trial
      const task = byId.get(trial.taskId)
      if (task === undefined) {
        outcomes[index] = {
          taskId: trial.taskId,
          trialIndex: trial.trialIndex,
          expected: null,
          pick: null,
          arguments: null,
          calls: [],
          text: '',
          callCount: 0,
          order: trial.order,
          expectedPosition: -1,
          latencyMs: 0,
          error: {
            message: `planned trial references unknown task \`${trial.taskId}\``,
            retryable: false,
          },
        }
      } else {
        outcomes[index] = await runOne(trial, task, tools, provider, options)
      }

      completed += 1
      // In-flight requests all settle after an abort. Do not print a burst of misleading
      // "error" progress lines while the CLI is already reporting that it was cancelled.
      if (!isAbortRequested(options.signal)) {
        options.onTrial?.(outcomes[index] as TrialOutcome, completed, plan.trials.length)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, plan.trials.length) }, worker))

  const settled = outcomes.filter((outcome): outcome is TrialOutcome => outcome !== undefined)
  return {
    outcomes: settled,
    durationMs: Date.now() - started,
    cancelled: isAbortRequested(options.signal),
  }
}
