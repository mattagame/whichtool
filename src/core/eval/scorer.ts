import { isJsonObject } from '../json.js'
import type { JsonValue, NormalizedTool } from '../types.js'
import type { TrialOutcome } from './runner.js'

export type Verdict =
  | 'correct'
  | 'wrong-tool'
  | 'phantom'
  | 'abstained'
  | 'correct-abstention'
  | 'over-triggered'
  | 'unexpected-additional-calls'
  | 'error'

export interface ArgumentCheck {
  missingRequired: string[]

  hallucinated: string[]

  wrongType: Array<{ name: string; expected: string; got: string }>

  parsed: boolean

  vacuous: boolean
}

export interface ScoredTrial extends TrialOutcome {
  verdict: Verdict

  /** True when the model proposed more than one tool call in the same turn. */
  unexpectedAdditionalCalls: boolean

  argumentCheck?: ArgumentCheck

  askedForClarification: boolean
}

const CLARIFICATION =
  /\b(which|what|could you (clarify|specify)|can you (clarify|specify)|do you mean|please (clarify|specify)|need more (info|information|detail))\b/i

function jsonTypeOf(value: JsonValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function typeMatches(declared: JsonValue | undefined, value: JsonValue): boolean {
  if (declared === undefined) return true
  const actual = jsonTypeOf(value)
  const accept = (name: string): boolean =>
    name === actual ||
    (name === 'number' && actual === 'integer') ||
    (name === 'integer' && actual === 'number' && Number.isInteger(value as number))

  if (typeof declared === 'string') return accept(declared)
  if (Array.isArray(declared))
    return declared.some((item) => typeof item === 'string' && accept(item))
  return true
}

export function checkArguments(tool: NormalizedTool, outcome: TrialOutcome): ArgumentCheck {
  const schema = tool.inputSchemaResolved
  const properties = isJsonObject(schema['properties']) ? schema['properties'] : {}
  const declared = Object.keys(properties)
  const required = Array.isArray(schema['required'])
    ? (schema['required'] as JsonValue[]).filter((name): name is string => typeof name === 'string')
    : []

  const check: ArgumentCheck = {
    missingRequired: [],
    hallucinated: [],
    wrongType: [],
    parsed: outcome.rawArguments === undefined,
    vacuous: declared.length === 0 && required.length === 0,
  }

  const supplied = outcome.arguments ?? {}
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(supplied, name)) check.missingRequired.push(name)
  }
  for (const [name, value] of Object.entries(supplied)) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) {
      check.hallucinated.push(name)
      continue
    }
    const propertySchema = properties[name]
    if (!isJsonObject(propertySchema)) continue
    if (!typeMatches(propertySchema['type'], value)) {
      check.wrongType.push({
        name,
        expected: String(propertySchema['type']),
        got: jsonTypeOf(value),
      })
    }
  }

  check.missingRequired.sort()
  check.hallucinated.sort()
  return check
}

export function scoreTrial(
  outcome: TrialOutcome,
  toolsByName: Map<string, NormalizedTool>,
): ScoredTrial {
  const askedForClarification =
    outcome.calls.length === 0 &&
    outcome.pick === null &&
    outcome.text !== '' &&
    CLARIFICATION.test(outcome.text)
  const unexpectedAdditionalCalls = outcome.calls.length > 1 || outcome.callCount > 1
  const attemptedCall = outcome.calls.length > 0 || outcome.callCount > 0

  if (outcome.error !== undefined) {
    return {
      ...outcome,
      verdict: 'error',
      askedForClarification: false,
      unexpectedAdditionalCalls,
    }
  }

  const scored: ScoredTrial = {
    ...outcome,
    verdict: 'abstained',
    askedForClarification,
    unexpectedAdditionalCalls,
  }

  if (outcome.pick !== null) {
    const tool = toolsByName.get(outcome.pick)
    if (tool !== undefined) scored.argumentCheck = checkArguments(tool, outcome)
  }

  if (outcome.expected === null) {
    scored.verdict = attemptedCall ? 'over-triggered' : 'correct-abstention'
    return scored
  }
  if (outcome.pick === null) {
    scored.verdict = attemptedCall ? 'phantom' : 'abstained'
    return scored
  }
  if (outcome.pick === outcome.expected) {
    // A correct first pick followed by more calls is not a correct single-tool decision.
    // Keep the first-call compatibility projection, but make the invalid selection visible
    // in the verdict instead of silently inflating single-call accuracy.
    scored.verdict = unexpectedAdditionalCalls ? 'unexpected-additional-calls' : 'correct'
    return scored
  }
  scored.verdict = toolsByName.has(outcome.pick) ? 'wrong-tool' : 'phantom'
  return scored
}

export function scoreTrials(
  outcomes: readonly TrialOutcome[],
  tools: readonly NormalizedTool[],
): ScoredTrial[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return outcomes.map((outcome) => scoreTrial(outcome, byName))
}
