import { WhichtoolError } from '../errors.js'
import { computeMetrics, proportion, type RunMetrics } from '../eval/metrics.js'
import {
  MAX_CONCURRENCY,
  MAX_PLANNED_TRIALS,
  MAX_REPEAT,
  MAX_TEMPERATURE,
  MIN_CONCURRENCY,
  MIN_REPEAT,
  MIN_TEMPERATURE,
} from '../eval/options.js'
import { canonicalJson, isJsonObject } from '../json.js'
import { MAX_RECORDED_TOOL_CALLS, type RecordedToolCall } from '../providers/types.js'
import {
  DEFAULT_MAX_ERROR_RATE,
  DEFAULT_MIN_SCORED,
  RUN_SCHEMA_VERSION,
  type RunExecutionStatus,
  type RunReport,
} from '../run.js'
import type { ScoredTrial, Verdict } from '../eval/scorer.js'
import type { JsonObject, JsonValue, NormalizedTool } from '../types.js'

export const LEGACY_RUN_SCHEMA_VERSION = 'whichtool.run/1'
const VERDICTS = new Set<Verdict>([
  'correct',
  'wrong-tool',
  'phantom',
  'abstained',
  'correct-abstention',
  'over-triggered',
  'unexpected-additional-calls',
  'error',
])

function invalid(source: string, path: string, message: string): never {
  throw new WhichtoolError(
    'run/invalid-report',
    `${source}: \`${path}\` ${message}`,
    'Validate the artifact against the published whichtool run-report schema or regenerate it.',
  )
}

function required(object: JsonObject, key: string, source: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    invalid(source, `${path}.${key}`, 'is required.')
  }
  return object[key]
}

function objectAt(value: unknown, source: string, path: string): JsonObject {
  if (!isJsonObject(value)) invalid(source, path, 'must be an object.')
  return value
}

function rejectUnknownKeys(
  object: JsonObject,
  allowed: readonly string[],
  source: string,
  path: string,
): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(object).find((key) => !allowedKeys.has(key))
  if (unknown !== undefined) invalid(source, `${path}.${unknown}`, 'is not allowed.')
}

function rejectKeysAbsentFromExpected(
  actual: unknown,
  expected: unknown,
  source: string,
  path: string,
): void {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    for (let index = 0; index < Math.min(actual.length, expected.length); index += 1) {
      rejectKeysAbsentFromExpected(actual[index], expected[index], source, `${path}[${index}]`)
    }
    return
  }
  if (!isJsonObject(actual) || !isJsonObject(expected)) return
  for (const key of Object.keys(actual)) {
    if (!Object.prototype.hasOwnProperty.call(expected, key)) {
      invalid(source, `${path}.${key}`, 'is not allowed.')
    }
    rejectKeysAbsentFromExpected(actual[key], expected[key], source, `${path}.${key}`)
  }
}

function arrayAt(value: unknown, source: string, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(source, path, 'must be an array.')
  return value
}

function stringAt(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string') invalid(source, path, 'must be a string.')
  return value
}

function nullableStringAt(value: unknown, source: string, path: string): string | null {
  if (value !== null && typeof value !== 'string') {
    invalid(source, path, 'must be a string or null.')
  }
  return value
}

function booleanAt(value: unknown, source: string, path: string): boolean {
  if (typeof value !== 'boolean') invalid(source, path, 'must be a boolean.')
  return value
}

function numberAt(
  value: unknown,
  source: string,
  path: string,
  options: { integer?: boolean; minimum?: number; maximum?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(source, path, 'must be a finite number.')
  }
  if (options.integer === true && !Number.isSafeInteger(value)) {
    invalid(source, path, 'must be a safe integer.')
  }
  if (options.minimum !== undefined && value < options.minimum) {
    invalid(source, path, `must be at least ${options.minimum}.`)
  }
  if (options.maximum !== undefined && value > options.maximum) {
    invalid(source, path, `must be at most ${options.maximum}.`)
  }
  return value
}

function stringArrayAt(value: unknown, source: string, path: string): string[] {
  const items = arrayAt(value, source, path)
  return items.map((item, index) => stringAt(item, source, `${path}[${index}]`))
}

function optionalString(object: JsonObject, key: string, source: string, path: string): void {
  if (Object.prototype.hasOwnProperty.call(object, key)) {
    stringAt(object[key], source, `${path}.${key}`)
  }
}

function validateProportion(value: unknown, source: string, path: string): void {
  const rate = objectAt(value, source, path)
  rejectUnknownKeys(rate, ['numerator', 'denominator', 'value', 'ci95'], source, path)
  const numerator = numberAt(
    required(rate, 'numerator', source, path),
    source,
    `${path}.numerator`,
    {
      integer: true,
      minimum: 0,
    },
  )
  const denominator = numberAt(
    required(rate, 'denominator', source, path),
    source,
    `${path}.denominator`,
    { integer: true, minimum: 0 },
  )
  if (numerator > denominator) invalid(source, path, 'has a numerator larger than its denominator.')
  const expected = proportion(numerator, denominator)
  const measured = required(rate, 'value', source, path)
  const interval = required(rate, 'ci95', source, path)
  if (expected.value === null) {
    if (measured !== null || interval !== null) {
      invalid(source, path, 'must use null for both value and ci95 when the denominator is zero.')
    }
    return
  }
  const actual = numberAt(measured, source, `${path}.value`, { minimum: 0, maximum: 1 })
  if (Math.abs(actual - expected.value) > 1e-12) {
    invalid(source, `${path}.value`, 'does not equal numerator / denominator.')
  }
  const bounds = arrayAt(interval, source, `${path}.ci95`)
  if (bounds.length !== 2) invalid(source, `${path}.ci95`, 'must contain two bounds.')
  const lower = numberAt(bounds[0], source, `${path}.ci95[0]`, { minimum: 0, maximum: 1 })
  const upper = numberAt(bounds[1], source, `${path}.ci95[1]`, { minimum: 0, maximum: 1 })
  if (lower > upper) invalid(source, `${path}.ci95`, 'has its bounds in the wrong order.')
}

function validateDiagnostic(
  value: unknown,
  source: string,
  path: string,
): 'error' | 'warning' | 'info' {
  const diagnostic = objectAt(value, source, path)
  rejectUnknownKeys(
    diagnostic,
    ['code', 'severity', 'message', 'tool', 'tools', 'detail'],
    source,
    path,
  )
  stringAt(required(diagnostic, 'code', source, path), source, `${path}.code`)
  const severity = stringAt(
    required(diagnostic, 'severity', source, path),
    source,
    `${path}.severity`,
  )
  if (severity !== 'error' && severity !== 'warning' && severity !== 'info') {
    invalid(source, `${path}.severity`, 'must be error, warning, or info.')
  }
  stringAt(required(diagnostic, 'message', source, path), source, `${path}.message`)
  optionalString(diagnostic, 'tool', source, path)
  if (diagnostic['tools'] !== undefined) stringArrayAt(diagnostic['tools'], source, `${path}.tools`)
  if (diagnostic['detail'] !== undefined) objectAt(diagnostic['detail'], source, `${path}.detail`)
  return severity
}

interface ValidatedThreshold {
  name: 'minAccuracy' | 'maxOverTrigger' | 'maxContextTokens'
  limit: number
  actual: number
  ok: boolean
  path: string
}

function validateThreshold(value: unknown, source: string, path: string): ValidatedThreshold {
  const threshold = objectAt(value, source, path)
  rejectUnknownKeys(threshold, ['name', 'limit', 'actual', 'ok'], source, path)
  const name = stringAt(required(threshold, 'name', source, path), source, `${path}.name`)
  if (name !== 'minAccuracy' && name !== 'maxOverTrigger' && name !== 'maxContextTokens') {
    invalid(source, `${path}.name`, 'is not a supported run threshold.')
  }
  const countThreshold = name === 'maxContextTokens'
  const options = countThreshold
    ? ({ integer: true, minimum: 0 } as const)
    : ({ minimum: 0, maximum: 1 } as const)
  const limit = numberAt(
    required(threshold, 'limit', source, path),
    source,
    `${path}.limit`,
    options,
  )
  const actual = numberAt(
    required(threshold, 'actual', source, path),
    source,
    `${path}.actual`,
    options,
  )
  const ok = booleanAt(required(threshold, 'ok', source, path), source, `${path}.ok`)
  return { name, limit, actual, ok, path }
}

function validateArgumentCheck(value: unknown, source: string, path: string): void {
  const check = objectAt(value, source, path)
  rejectUnknownKeys(
    check,
    ['missingRequired', 'hallucinated', 'wrongType', 'parsed', 'vacuous'],
    source,
    path,
  )
  stringArrayAt(required(check, 'missingRequired', source, path), source, `${path}.missingRequired`)
  stringArrayAt(required(check, 'hallucinated', source, path), source, `${path}.hallucinated`)
  const wrong = arrayAt(required(check, 'wrongType', source, path), source, `${path}.wrongType`)
  for (const [index, valueAtIndex] of wrong.entries()) {
    const itemPath = `${path}.wrongType[${index}]`
    const item = objectAt(valueAtIndex, source, itemPath)
    rejectUnknownKeys(item, ['name', 'expected', 'got'], source, itemPath)
    for (const key of ['name', 'expected', 'got']) {
      stringAt(required(item, key, source, itemPath), source, `${itemPath}.${key}`)
    }
  }
  booleanAt(required(check, 'parsed', source, path), source, `${path}.parsed`)
  booleanAt(required(check, 'vacuous', source, path), source, `${path}.vacuous`)
}

function validateCall(value: unknown, source: string, path: string): RecordedToolCall {
  const call = objectAt(value, source, path)
  rejectUnknownKeys(call, ['name', 'arguments', 'rawArguments'], source, path)
  const name = nullableStringAt(required(call, 'name', source, path), source, `${path}.name`)
  const rawArguments = call['rawArguments']
  if (rawArguments !== undefined) stringAt(rawArguments, source, `${path}.rawArguments`)
  const rawObject = required(call, 'arguments', source, path)
  const argumentsObject =
    rawObject === null ? null : objectAt(rawObject, source, `${path}.arguments`)
  return {
    name,
    arguments: argumentsObject,
    ...(typeof rawArguments === 'string' ? { rawArguments } : {}),
  }
}

function validateTrial(value: unknown, source: string, path: string): ScoredTrial {
  const trial = objectAt(value, source, path)
  rejectUnknownKeys(
    trial,
    [
      'taskId',
      'trialIndex',
      'expected',
      'pick',
      'arguments',
      'rawArguments',
      'calls',
      'text',
      'callCount',
      'order',
      'expectedPosition',
      'latencyMs',
      'usage',
      'reasoningChars',
      'error',
      'verdict',
      'unexpectedAdditionalCalls',
      'argumentCheck',
      'askedForClarification',
    ],
    source,
    path,
  )
  stringAt(required(trial, 'taskId', source, path), source, `${path}.taskId`)
  numberAt(required(trial, 'trialIndex', source, path), source, `${path}.trialIndex`, {
    integer: true,
    minimum: 0,
  })
  const expected = nullableStringAt(
    required(trial, 'expected', source, path),
    source,
    `${path}.expected`,
  )
  const pick = nullableStringAt(required(trial, 'pick', source, path), source, `${path}.pick`)
  const rawArguments = trial['rawArguments']
  if (rawArguments !== undefined) stringAt(rawArguments, source, `${path}.rawArguments`)
  const argumentValue = required(trial, 'arguments', source, path)
  const argumentsObject =
    argumentValue === null ? null : objectAt(argumentValue, source, `${path}.arguments`)
  const callValues = arrayAt(required(trial, 'calls', source, path), source, `${path}.calls`)
  if (callValues.length > MAX_RECORDED_TOOL_CALLS) {
    invalid(source, `${path}.calls`, `must contain at most ${MAX_RECORDED_TOOL_CALLS} calls.`)
  }
  const calls = callValues.map((call, index) =>
    validateCall(call, source, `${path}.calls[${index}]`),
  )
  const callCount = numberAt(
    required(trial, 'callCount', source, path),
    source,
    `${path}.callCount`,
    {
      integer: true,
      minimum: 0,
      maximum: MAX_RECORDED_TOOL_CALLS,
    },
  )
  if (callCount !== calls.length) invalid(source, `${path}.callCount`, 'must equal calls.length.')

  const first = calls[0]
  if (pick !== (first?.name ?? null)) invalid(source, `${path}.pick`, 'must project calls[0].name.')
  if (
    canonicalJson(argumentsObject as JsonValue) !==
    canonicalJson((first?.arguments ?? null) as JsonValue)
  ) {
    invalid(source, `${path}.arguments`, 'must project calls[0].arguments.')
  }
  if (rawArguments !== first?.rawArguments) {
    invalid(source, `${path}.rawArguments`, 'must project calls[0].rawArguments.')
  }

  const text = stringAt(required(trial, 'text', source, path), source, `${path}.text`)
  stringArrayAt(required(trial, 'order', source, path), source, `${path}.order`)
  numberAt(required(trial, 'expectedPosition', source, path), source, `${path}.expectedPosition`, {
    integer: true,
    minimum: -1,
  })
  const latencyMs = numberAt(
    required(trial, 'latencyMs', source, path),
    source,
    `${path}.latencyMs`,
    { minimum: 0 },
  )
  if (trial['usage'] !== undefined) {
    const usage = objectAt(trial['usage'], source, `${path}.usage`)
    rejectUnknownKeys(usage, ['promptTokens', 'completionTokens'], source, `${path}.usage`)
    if (usage['promptTokens'] !== undefined) {
      numberAt(usage['promptTokens'], source, `${path}.usage.promptTokens`, {
        integer: true,
        minimum: 0,
      })
    }
    if (usage['completionTokens'] !== undefined) {
      numberAt(usage['completionTokens'], source, `${path}.usage.completionTokens`, {
        integer: true,
        minimum: 0,
      })
    }
  }
  if (trial['reasoningChars'] !== undefined) {
    numberAt(trial['reasoningChars'], source, `${path}.reasoningChars`, {
      integer: true,
      minimum: 0,
    })
  }
  if (trial['error'] !== undefined) {
    const error = objectAt(trial['error'], source, `${path}.error`)
    rejectUnknownKeys(error, ['message', 'retryable', 'hint'], source, `${path}.error`)
    stringAt(required(error, 'message', source, `${path}.error`), source, `${path}.error.message`)
    booleanAt(
      required(error, 'retryable', source, `${path}.error`),
      source,
      `${path}.error.retryable`,
    )
    optionalString(error, 'hint', source, `${path}.error`)
  }
  const verdict = stringAt(required(trial, 'verdict', source, path), source, `${path}.verdict`)
  if (!VERDICTS.has(verdict as Verdict)) invalid(source, `${path}.verdict`, 'is not recognised.')
  const unexpected = booleanAt(
    required(trial, 'unexpectedAdditionalCalls', source, path),
    source,
    `${path}.unexpectedAdditionalCalls`,
  )
  if (unexpected !== calls.length > 1) {
    invalid(
      source,
      `${path}.unexpectedAdditionalCalls`,
      'must reflect whether calls has more than one item.',
    )
  }
  const askedForClarification = booleanAt(
    required(trial, 'askedForClarification', source, path),
    source,
    `${path}.askedForClarification`,
  )
  if (trial['argumentCheck'] !== undefined) {
    validateArgumentCheck(trial['argumentCheck'], source, `${path}.argumentCheck`)
  }
  if ((trial['error'] !== undefined) !== (verdict === 'error')) {
    invalid(source, `${path}.verdict`, 'must be error exactly when the trial has an error object.')
  }
  if (verdict === 'error') {
    if (calls.length !== 0 || text !== '' || latencyMs !== 0 || askedForClarification) {
      invalid(
        source,
        path,
        'must carry no calls, text, latency, or clarification when the runner failed.',
      )
    }
    if (
      trial['usage'] !== undefined ||
      trial['reasoningChars'] !== undefined ||
      trial['argumentCheck'] !== undefined
    ) {
      invalid(
        source,
        path,
        'must not carry usage, reasoning, or argument checks when the runner failed.',
      )
    }
  }
  if (verdict === 'unexpected-additional-calls' && !unexpected) {
    invalid(source, `${path}.verdict`, 'requires more than one recorded call.')
  }
  if (expected === null && verdict !== 'error') {
    const wanted = calls.length > 0 ? 'over-triggered' : 'correct-abstention'
    if (verdict !== wanted)
      invalid(source, `${path}.verdict`, `must be ${wanted} for this distractor.`)
  }
  return trial as unknown as ScoredTrial
}

function normalizeLegacyTrial(value: unknown, source: string, path: string): JsonObject {
  const trial = objectAt(value, source, path)
  const callCount = numberAt(
    required(trial, 'callCount', source, path),
    source,
    `${path}.callCount`,
    {
      integer: true,
      minimum: 0,
      maximum: MAX_RECORDED_TOOL_CALLS,
    },
  )
  const pick = nullableStringAt(required(trial, 'pick', source, path), source, `${path}.pick`)
  const argumentsValue = required(trial, 'arguments', source, path)
  const argumentsObject =
    argumentsValue === null ? null : objectAt(argumentsValue, source, `${path}.arguments`)
  const rawArguments = trial['rawArguments']
  if (rawArguments !== undefined) stringAt(rawArguments, source, `${path}.rawArguments`)
  if (
    callCount === 0 &&
    (pick !== null || argumentsObject !== null || rawArguments !== undefined)
  ) {
    invalid(source, path, 'records first-call data while callCount is zero.')
  }

  const calls: JsonObject[] = []
  if (callCount > 0) {
    calls.push({
      name: pick,
      arguments: argumentsObject,
      ...(typeof rawArguments === 'string' ? { rawArguments } : {}),
    })
    while (calls.length < callCount) calls.push({ name: null, arguments: null })
  }

  const expected = nullableStringAt(
    required(trial, 'expected', source, path),
    source,
    `${path}.expected`,
  )
  const oldVerdict = stringAt(required(trial, 'verdict', source, path), source, `${path}.verdict`)
  if (!VERDICTS.has(oldVerdict as Verdict)) invalid(source, `${path}.verdict`, 'is not recognised.')
  let verdict = oldVerdict
  if (oldVerdict !== 'error') {
    if (expected === null) verdict = callCount > 0 ? 'over-triggered' : 'correct-abstention'
    else if (pick === null) verdict = callCount > 0 ? 'phantom' : 'abstained'
    else if (pick === expected && callCount > 1) verdict = 'unexpected-additional-calls'
  }

  return {
    ...trial,
    calls,
    callCount: calls.length,
    unexpectedAdditionalCalls: calls.length > 1,
    verdict,
  }
}

function validateCommonReport(
  report: JsonObject,
  source: string,
): {
  trials: ScoredTrial[]
  metricsObject: JsonObject
  computedMetrics: RunMetrics
  thresholdsOk: boolean
  diagnosticsOk: boolean
  selected: number
  repeat: number
} {
  rejectUnknownKeys(
    report,
    [
      'schemaVersion',
      'reproducibility',
      'target',
      'tasks',
      'metrics',
      'contextCost',
      'diagnostics',
      'thresholds',
      'thresholdsOk',
      'execution',
      'ok',
      'durationMs',
      'trials',
    ],
    source,
    '$',
  )
  const reproducibility = objectAt(
    required(report, 'reproducibility', source, '$'),
    source,
    '$.reproducibility',
  )
  rejectUnknownKeys(
    reproducibility,
    [
      'whichtoolVersion',
      'provider',
      'model',
      'endpoint',
      'requestFingerprint',
      'providerCapabilities',
      'temperature',
      'reasoningEffort',
      'seed',
      'repeat',
      'permuted',
      'concurrency',
      'surfaceHash',
      'taskSetVersion',
      'taskSetSource',
      'taskSetSurface',
    ],
    source,
    '$.reproducibility',
  )
  for (const key of ['whichtoolVersion', 'provider', 'model', 'surfaceHash', 'taskSetSource']) {
    stringAt(
      required(reproducibility, key, source, '$.reproducibility'),
      source,
      `$.reproducibility.${key}`,
    )
  }
  nullableStringAt(
    required(reproducibility, 'endpoint', source, '$.reproducibility'),
    source,
    '$.reproducibility.endpoint',
  )
  nullableStringAt(
    required(reproducibility, 'requestFingerprint', source, '$.reproducibility'),
    source,
    '$.reproducibility.requestFingerprint',
  )
  nullableStringAt(
    required(reproducibility, 'reasoningEffort', source, '$.reproducibility'),
    source,
    '$.reproducibility.reasoningEffort',
  )
  const capabilities = objectAt(
    required(reproducibility, 'providerCapabilities', source, '$.reproducibility'),
    source,
    '$.reproducibility.providerCapabilities',
  )
  rejectUnknownKeys(
    capabilities,
    ['seed', 'temperatureZero', 'logprobs', 'disableThinking'],
    source,
    '$.reproducibility.providerCapabilities',
  )
  for (const key of ['seed', 'temperatureZero', 'logprobs', 'disableThinking']) {
    booleanAt(
      required(capabilities, key, source, '$.reproducibility.providerCapabilities'),
      source,
      `$.reproducibility.providerCapabilities.${key}`,
    )
  }
  numberAt(
    required(reproducibility, 'temperature', source, '$.reproducibility'),
    source,
    '$.reproducibility.temperature',
    { minimum: MIN_TEMPERATURE, maximum: MAX_TEMPERATURE },
  )
  numberAt(
    required(reproducibility, 'seed', source, '$.reproducibility'),
    source,
    '$.reproducibility.seed',
    {
      integer: true,
    },
  )
  const repeat = numberAt(
    required(reproducibility, 'repeat', source, '$.reproducibility'),
    source,
    '$.reproducibility.repeat',
    { integer: true, minimum: MIN_REPEAT, maximum: MAX_REPEAT },
  )
  booleanAt(
    required(reproducibility, 'permuted', source, '$.reproducibility'),
    source,
    '$.reproducibility.permuted',
  )
  numberAt(
    required(reproducibility, 'concurrency', source, '$.reproducibility'),
    source,
    '$.reproducibility.concurrency',
    { integer: true, minimum: MIN_CONCURRENCY, maximum: MAX_CONCURRENCY },
  )
  numberAt(
    required(reproducibility, 'taskSetVersion', source, '$.reproducibility'),
    source,
    '$.reproducibility.taskSetVersion',
    { integer: true },
  )
  nullableStringAt(
    required(reproducibility, 'taskSetSurface', source, '$.reproducibility'),
    source,
    '$.reproducibility.taskSetSurface',
  )

  const target = objectAt(required(report, 'target', source, '$'), source, '$.target')
  rejectUnknownKeys(target, ['transport', 'ref'], source, '$.target')
  stringAt(required(target, 'transport', source, '$.target'), source, '$.target.transport')
  stringAt(required(target, 'ref', source, '$.target'), source, '$.target.ref')

  const tasks = objectAt(required(report, 'tasks', source, '$'), source, '$.tasks')
  rejectUnknownKeys(
    tasks,
    ['inFile', 'selected', 'distractors', 'only', 'skip', 'list'],
    source,
    '$.tasks',
  )
  const inFile = numberAt(required(tasks, 'inFile', source, '$.tasks'), source, '$.tasks.inFile', {
    integer: true,
    minimum: 0,
  })
  const selected = numberAt(
    required(tasks, 'selected', source, '$.tasks'),
    source,
    '$.tasks.selected',
    { integer: true, minimum: 0, maximum: MAX_PLANNED_TRIALS },
  )
  const distractors = numberAt(
    required(tasks, 'distractors', source, '$.tasks'),
    source,
    '$.tasks.distractors',
    { integer: true, minimum: 0 },
  )
  if (selected > inFile) invalid(source, '$.tasks.selected', 'cannot exceed tasks.inFile.')
  stringArrayAt(required(tasks, 'only', source, '$.tasks'), source, '$.tasks.only')
  stringArrayAt(required(tasks, 'skip', source, '$.tasks'), source, '$.tasks.skip')
  const taskValues = arrayAt(required(tasks, 'list', source, '$.tasks'), source, '$.tasks.list')
  if (taskValues.length > MAX_PLANNED_TRIALS) {
    invalid(source, '$.tasks.list', `must contain at most ${MAX_PLANNED_TRIALS} tasks.`)
  }
  if (taskValues.length !== selected)
    invalid(source, '$.tasks.list', 'must contain tasks.selected items.')
  const taskList = taskValues.map((value, index) => {
    const path = `$.tasks.list[${index}]`
    const task = objectAt(value, source, path)
    rejectUnknownKeys(task, ['id', 'prompt', 'expected', 'tags'], source, path)
    const id = stringAt(required(task, 'id', source, path), source, `${path}.id`)
    const prompt = stringAt(required(task, 'prompt', source, path), source, `${path}.prompt`)
    const expected = nullableStringAt(
      required(task, 'expected', source, path),
      source,
      `${path}.expected`,
    )
    const tags = stringArrayAt(required(task, 'tags', source, path), source, `${path}.tags`)
    return { id, prompt, expected, tags }
  })
  if (new Set(taskList.map((task) => task.id)).size !== taskList.length) {
    invalid(source, '$.tasks.list', 'contains duplicate task ids.')
  }
  if (taskList.filter((task) => task.expected === null).length !== distractors) {
    invalid(source, '$.tasks.distractors', 'does not match the selected task list.')
  }

  const context = objectAt(required(report, 'contextCost', source, '$'), source, '$.contextCost')
  rejectUnknownKeys(
    context,
    ['tokenizer', 'serialization', 'total', 'byTool'],
    source,
    '$.contextCost',
  )
  const tokenizer = objectAt(
    required(context, 'tokenizer', source, '$.contextCost'),
    source,
    '$.contextCost.tokenizer',
  )
  rejectUnknownKeys(
    tokenizer,
    ['id', 'exact', 'approximates', 'note'],
    source,
    '$.contextCost.tokenizer',
  )
  stringAt(
    required(tokenizer, 'id', source, '$.contextCost.tokenizer'),
    source,
    '$.contextCost.tokenizer.id',
  )
  booleanAt(
    required(tokenizer, 'exact', source, '$.contextCost.tokenizer'),
    source,
    '$.contextCost.tokenizer.exact',
  )
  nullableStringAt(
    required(tokenizer, 'approximates', source, '$.contextCost.tokenizer'),
    source,
    '$.contextCost.tokenizer.approximates',
  )
  stringAt(
    required(tokenizer, 'note', source, '$.contextCost.tokenizer'),
    source,
    '$.contextCost.tokenizer.note',
  )
  stringAt(
    required(context, 'serialization', source, '$.contextCost'),
    source,
    '$.contextCost.serialization',
  )
  const contextTotal = numberAt(
    required(context, 'total', source, '$.contextCost'),
    source,
    '$.contextCost.total',
    {
      integer: true,
      minimum: 0,
    },
  )
  const tokenByTool = objectAt(
    required(context, 'byTool', source, '$.contextCost'),
    source,
    '$.contextCost.byTool',
  )
  const contextTokensByTool = Object.create(null) as Record<string, { total: number }>
  let summedContextTotal = 0
  for (const [tool, rawBreakdown] of Object.entries(tokenByTool)) {
    const path = `$.contextCost.byTool.${tool}`
    const breakdown = objectAt(rawBreakdown, source, path)
    rejectUnknownKeys(
      breakdown,
      ['total', 'name', 'description', 'schema', 'envelope'],
      source,
      path,
    )
    const parts: Record<string, number> = {}
    for (const key of ['total', 'name', 'description', 'schema', 'envelope'] as const) {
      parts[key] = numberAt(required(breakdown, key, source, path), source, `${path}.${key}`, {
        integer: true,
        minimum: 0,
      })
    }
    const componentTotal =
      (parts['name'] as number) +
      (parts['description'] as number) +
      (parts['schema'] as number) +
      (parts['envelope'] as number)
    if (!Number.isSafeInteger(componentTotal)) {
      invalid(source, path, 'has component counts whose sum is not a safe integer.')
    }
    if (parts['total'] !== componentTotal) {
      invalid(source, `${path}.total`, 'must equal name + description + schema + envelope.')
    }
    const total = parts['total'] as number
    contextTokensByTool[tool] = { total }
    summedContextTotal += total
    if (!Number.isSafeInteger(summedContextTotal)) {
      invalid(source, '$.contextCost.total', 'cannot be represented as a safe integer.')
    }
  }
  if (contextTotal !== summedContextTotal) {
    invalid(source, '$.contextCost.total', 'must equal the sum of contextCost.byTool totals.')
  }

  const diagnostics = arrayAt(required(report, 'diagnostics', source, '$'), source, '$.diagnostics')
  const diagnosticSeverities = diagnostics.map((value, index) =>
    validateDiagnostic(value, source, `$.diagnostics[${index}]`),
  )
  const thresholds = arrayAt(required(report, 'thresholds', source, '$'), source, '$.thresholds')
  const thresholdResults = thresholds.map((value, index) =>
    validateThreshold(value, source, `$.thresholds[${index}]`),
  )
  if (
    new Set(thresholdResults.map((threshold) => threshold.name)).size !== thresholdResults.length
  ) {
    invalid(source, '$.thresholds', 'contains a duplicate threshold name.')
  }
  numberAt(required(report, 'durationMs', source, '$'), source, '$.durationMs', { minimum: 0 })

  const trialValues = arrayAt(required(report, 'trials', source, '$'), source, '$.trials')
  if (trialValues.length > MAX_PLANNED_TRIALS) {
    invalid(source, '$.trials', `must contain at most ${MAX_PLANNED_TRIALS} trials.`)
  }
  const trials = trialValues.map((value, index) =>
    validateTrial(value, source, `$.trials[${index}]`),
  )
  const taskById = new Map(taskList.map((task) => [task.id, task]))
  const trialKeys = new Set<string>()
  for (const [index, trial] of trials.entries()) {
    const task = taskById.get(trial.taskId)
    if (task === undefined)
      invalid(source, `$.trials[${index}].taskId`, 'does not name a selected task.')
    if (trial.expected !== task.expected) {
      invalid(source, `$.trials[${index}].expected`, 'does not match the selected task oracle.')
    }
    if (trial.trialIndex >= repeat) {
      invalid(
        source,
        `$.trials[${index}].trialIndex`,
        'must be smaller than reproducibility.repeat.',
      )
    }
    const key = `${trial.taskId}\u0000${trial.trialIndex}`
    if (trialKeys.has(key))
      invalid(source, `$.trials[${index}]`, 'duplicates a task/trial index pair.')
    trialKeys.add(key)
  }

  const metricsObject = objectAt(required(report, 'metrics', source, '$'), source, '$.metrics')
  rejectUnknownKeys(
    metricsObject,
    [
      'trials',
      'accuracy',
      'abstention',
      'overTrigger',
      'phantom',
      'multiCallRate',
      'clarification',
      'byTool',
      'confusionMatrix',
      'confusionPairs',
      'position',
      'minTrialsPerTool',
    ],
    source,
    '$.metrics',
  )
  const byTool = arrayAt(
    required(metricsObject, 'byTool', source, '$.metrics'),
    source,
    '$.metrics.byTool',
  )
  const tools: NormalizedTool[] = []
  const toolNames = new Set<string>()
  for (const [index, rawTool] of byTool.entries()) {
    const path = `$.metrics.byTool[${index}]`
    const toolMetric = objectAt(rawTool, source, path)
    rejectUnknownKeys(
      toolMetric,
      [
        'tool',
        'accuracy',
        'confusedWith',
        'abstained',
        'phantom',
        'errors',
        'argumentAccuracy',
        'hallucinatedParameters',
        'contextTokens',
      ],
      source,
      path,
    )
    const name = stringAt(required(toolMetric, 'tool', source, path), source, `${path}.tool`)
    if (toolNames.has(name)) invalid(source, `${path}.tool`, 'duplicates another tool metric.')
    toolNames.add(name)
    numberAt(required(toolMetric, 'contextTokens', source, path), source, `${path}.contextTokens`, {
      integer: true,
      minimum: 0,
    })
    tools.push({
      name,
      description: '',
      hasDescription: false,
      inputSchema: {},
      inputSchemaResolved: {},
      originalIndex: index,
    })
  }
  const contextToolNames = Object.keys(contextTokensByTool)
  if (
    contextToolNames.length !== toolNames.size ||
    contextToolNames.some((name) => !toolNames.has(name))
  ) {
    invalid(source, '$.contextCost.byTool', 'must name exactly the tools in metrics.byTool.')
  }
  for (const [index, task] of taskList.entries()) {
    if (task.expected !== null && !toolNames.has(task.expected)) {
      invalid(source, `$.tasks.list[${index}].expected`, 'does not name a reported tool.')
    }
  }
  for (const [index, trial] of trials.entries()) {
    const orderNames = new Set(trial.order)
    if (
      trial.order.length !== toolNames.size ||
      orderNames.size !== toolNames.size ||
      trial.order.some((name) => !toolNames.has(name))
    ) {
      invalid(source, `$.trials[${index}].order`, 'must be a permutation of the reported tools.')
    }
    const expectedPosition = trial.expected === null ? -1 : trial.order.indexOf(trial.expected)
    if (trial.expectedPosition !== expectedPosition) {
      invalid(
        source,
        `$.trials[${index}].expectedPosition`,
        'must be -1 for a distractor or the expected tool index in order.',
      )
    }
  }
  const onSurface = new Set(tools.map((tool) => tool.name))
  for (const [index, trial] of trials.entries()) {
    if (trial.verdict === 'error' || trial.expected === null) continue
    const wanted =
      trial.pick === null
        ? trial.calls.length > 0
          ? 'phantom'
          : 'abstained'
        : trial.pick === trial.expected
          ? trial.calls.length > 1
            ? 'unexpected-additional-calls'
            : 'correct'
          : onSurface.has(trial.pick)
            ? 'wrong-tool'
            : 'phantom'
    if (trial.verdict !== wanted) {
      invalid(source, `$.trials[${index}].verdict`, `must be ${wanted} for its recorded calls.`)
    }
  }
  const computedMetrics = computeMetrics(trials, taskList, tools, contextTokensByTool)
  rejectKeysAbsentFromExpected(metricsObject, computedMetrics, source, '$.metrics')
  for (const threshold of thresholdResults) {
    const measured =
      threshold.name === 'minAccuracy'
        ? computedMetrics.accuracy.value
        : threshold.name === 'maxOverTrigger'
          ? computedMetrics.overTrigger.value
          : contextTotal
    const expectedActual = measured ?? (threshold.name === 'minAccuracy' ? 0 : 1)
    const expectedOk =
      measured !== null &&
      (threshold.name === 'minAccuracy' ? measured >= threshold.limit : measured <= threshold.limit)
    if (threshold.actual !== expectedActual) {
      invalid(source, `${threshold.path}.actual`, 'does not match the measured report value.')
    }
    if (threshold.ok !== expectedOk) {
      invalid(source, `${threshold.path}.ok`, 'does not match its limit and measured value.')
    }
  }
  return {
    trials,
    metricsObject,
    computedMetrics,
    thresholdsOk: thresholdResults.every((threshold) => threshold.ok),
    diagnosticsOk: !diagnosticSeverities.includes('error'),
    selected,
    repeat,
  }
}

function validateExecutionAndVerdict(
  report: JsonObject,
  source: string,
  context: ReturnType<typeof validateCommonReport>,
): void {
  const execution = objectAt(required(report, 'execution', source, '$'), source, '$.execution')
  rejectUnknownKeys(
    execution,
    ['ok', 'planned', 'completed', 'scored', 'errored', 'errorRate', 'maxErrorRate', 'minScored'],
    source,
    '$.execution',
  )
  const ok = booleanAt(required(execution, 'ok', source, '$.execution'), source, '$.execution.ok')
  const planned = numberAt(
    required(execution, 'planned', source, '$.execution'),
    source,
    '$.execution.planned',
    { integer: true, minimum: 0, maximum: MAX_PLANNED_TRIALS },
  )
  const completed = numberAt(
    required(execution, 'completed', source, '$.execution'),
    source,
    '$.execution.completed',
    { integer: true, minimum: 0, maximum: MAX_PLANNED_TRIALS },
  )
  const scored = numberAt(
    required(execution, 'scored', source, '$.execution'),
    source,
    '$.execution.scored',
    { integer: true, minimum: 0, maximum: MAX_PLANNED_TRIALS },
  )
  const errored = numberAt(
    required(execution, 'errored', source, '$.execution'),
    source,
    '$.execution.errored',
    { integer: true, minimum: 0, maximum: MAX_PLANNED_TRIALS },
  )
  validateProportion(
    required(execution, 'errorRate', source, '$.execution'),
    source,
    '$.execution.errorRate',
  )
  const maxErrorRate = numberAt(
    required(execution, 'maxErrorRate', source, '$.execution'),
    source,
    '$.execution.maxErrorRate',
    { minimum: 0, maximum: 1 },
  )
  const minScored = numberAt(
    required(execution, 'minScored', source, '$.execution'),
    source,
    '$.execution.minScored',
    { integer: true, minimum: 1 },
  )
  const expectedPlanned = context.selected * context.repeat
  if (!Number.isSafeInteger(expectedPlanned)) {
    invalid(source, '$.execution.planned', 'cannot represent tasks.selected * repeat safely.')
  }
  if (planned !== expectedPlanned) {
    invalid(source, '$.execution.planned', 'must equal tasks.selected * reproducibility.repeat.')
  }
  const expectedCompleted = context.trials.length
  const expectedScored = context.trials.filter((trial) => trial.verdict !== 'error').length
  const expectedErrored = Math.max(0, planned - expectedScored)
  if (completed !== expectedCompleted)
    invalid(source, '$.execution.completed', 'does not match trials.length.')
  if (scored !== expectedScored)
    invalid(source, '$.execution.scored', 'does not match the scored trials.')
  if (errored !== expectedErrored)
    invalid(source, '$.execution.errored', 'does not match planned - scored.')
  const expectedRate = proportion(expectedErrored, planned)
  if (
    canonicalJson(execution['errorRate'] as JsonValue) !==
    canonicalJson(expectedRate as unknown as JsonValue)
  ) {
    invalid(source, '$.execution.errorRate', 'does not match the execution counts.')
  }
  const expectedOk =
    planned > 0 &&
    completed === planned &&
    scored >= minScored &&
    expectedRate.value !== null &&
    expectedRate.value <= maxErrorRate
  if (ok !== expectedOk) invalid(source, '$.execution.ok', 'does not match the execution policy.')

  const thresholdsOk = booleanAt(
    required(report, 'thresholdsOk', source, '$'),
    source,
    '$.thresholdsOk',
  )
  if (thresholdsOk !== context.thresholdsOk) {
    invalid(source, '$.thresholdsOk', 'does not match the threshold results.')
  }
  const headline = booleanAt(required(report, 'ok', source, '$'), source, '$.ok')
  if (headline !== (ok && thresholdsOk && context.diagnosticsOk)) {
    invalid(source, '$.ok', 'must equal execution.ok && thresholdsOk && no error diagnostics.')
  }
}

function upgradeLegacy(payload: JsonObject, source: string): JsonObject {
  const trialValues = arrayAt(required(payload, 'trials', source, '$'), source, '$.trials')
  const reproducibility = objectAt(
    required(payload, 'reproducibility', source, '$'),
    source,
    '$.reproducibility',
  )
  return {
    ...payload,
    schemaVersion: RUN_SCHEMA_VERSION,
    reproducibility: { ...reproducibility, requestFingerprint: null },
    trials: trialValues.map((trial, index) =>
      normalizeLegacyTrial(trial, source, `$.trials[${index}]`),
    ),
  }
}

export function parseRunReport(payload: unknown, source: string): RunReport {
  if (!isJsonObject(payload)) {
    throw new WhichtoolError('run/not-a-report', `${source} does not contain a run report.`)
  }
  const version = payload['schemaVersion']
  const legacy = version === LEGACY_RUN_SCHEMA_VERSION
  if (!legacy && version !== RUN_SCHEMA_VERSION) {
    throw new WhichtoolError(
      'run/unsupported-schema',
      `${source} declares schema \`${String(version)}\`, but this build reads \`${RUN_SCHEMA_VERSION}\` and \`${LEGACY_RUN_SCHEMA_VERSION}\`.`,
      'Regenerate the report with a supported whichtool version.',
    )
  }

  const report = legacy ? upgradeLegacy(payload, source) : ({ ...payload } as JsonObject)
  const context = validateCommonReport(report, source)
  if (legacy) {
    report['metrics'] = context.computedMetrics as unknown as JsonValue
    const planned = context.selected * context.repeat
    const completed = context.trials.length
    const scored = context.computedMetrics.trials.scored
    const errored = Math.max(0, planned - scored)
    const errorRate = proportion(errored, planned)
    const executionOk =
      planned > 0 &&
      completed === planned &&
      scored >= DEFAULT_MIN_SCORED &&
      errorRate.value !== null &&
      errorRate.value <= DEFAULT_MAX_ERROR_RATE
    const execution: RunExecutionStatus = {
      ok: executionOk,
      planned,
      completed,
      scored,
      errored,
      errorRate,
      maxErrorRate: DEFAULT_MAX_ERROR_RATE,
      minScored: DEFAULT_MIN_SCORED,
    }
    report['execution'] = execution as unknown as JsonValue
    report['thresholdsOk'] = context.thresholdsOk
    report['ok'] = executionOk && context.thresholdsOk && context.diagnosticsOk
  } else if (
    canonicalJson(context.metricsObject) !==
    canonicalJson(context.computedMetrics as unknown as JsonValue)
  ) {
    invalid(source, '$.metrics', 'does not match the recorded trials and selected tools.')
  }
  validateExecutionAndVerdict(report, source, context)
  return report as unknown as RunReport
}
