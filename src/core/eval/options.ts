import { WhichtoolError } from '../errors.js'

export const MIN_REPEAT = 1
export const MAX_REPEAT = 1_000
/** Normal per-invocation budget. Callers must opt in explicitly to a larger run. */
export const DEFAULT_MAX_TRIALS = 50
/** No real provider run may exceed this, even after an explicit override. */
export const ABSOLUTE_MAX_TRIALS = 1_000
/** Cautious default for the number of tools shown to a model in one evaluation turn. */
export const DEFAULT_MAX_TOOLS = 6
/** Resource-safety ceiling; the six-tool quality guard remains explicitly overridable. */
export const ABSOLUTE_MAX_TOOLS = 1_000
/** Allocation/parser ceiling. Dry runs may inspect plans that real execution would refuse. */
export const MAX_PLANNED_TRIALS = 100_000
export const MIN_CONCURRENCY = 1
export const MAX_CONCURRENCY = 64
export const MIN_TEMPERATURE = 0
export const MAX_TEMPERATURE = 2

function assertIntegerInRange(
  value: number,
  name: string,
  min: number,
  max: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WhichtoolError(
      code,
      `${name} must be a safe integer between ${min} and ${max}; received ${String(value)}.`,
    )
  }
  return value
}

export function assertRepeat(value: number): number {
  return assertIntegerInRange(value, 'repeat', MIN_REPEAT, MAX_REPEAT, 'trials/invalid-repeat')
}

export function assertMaxTrials(value: number): number {
  return assertIntegerInRange(
    value,
    'maxTrials',
    1,
    ABSOLUTE_MAX_TRIALS,
    'trials/invalid-max-trials',
  )
}

export function assertMaxTools(value: number): number {
  return assertIntegerInRange(value, 'maxTools', 1, ABSOLUTE_MAX_TOOLS, 'trials/invalid-max-tools')
}

export function assertConcurrency(value: number): number {
  return assertIntegerInRange(
    value,
    'concurrency',
    MIN_CONCURRENCY,
    MAX_CONCURRENCY,
    'trials/invalid-concurrency',
  )
}

export function assertTemperature(value: number): number {
  if (!Number.isFinite(value) || value < MIN_TEMPERATURE || value > MAX_TEMPERATURE) {
    throw new WhichtoolError(
      'trials/invalid-temperature',
      `temperature must be a finite number between ${MIN_TEMPERATURE} and ${MAX_TEMPERATURE}; received ${String(value)}.`,
    )
  }
  return value
}

export function assertSeed(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new WhichtoolError(
      'trials/invalid-seed',
      `seed must be a safe integer; received ${String(value)}.`,
    )
  }
  return value
}
