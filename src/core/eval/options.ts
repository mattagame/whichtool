import { WhichtoolError } from '../errors.js'

export const MIN_REPEAT = 1
export const MAX_REPEAT = 1_000
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
