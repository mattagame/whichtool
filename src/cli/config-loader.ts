import { WhichtoolError } from '../core/errors.js'
import {
  ABSOLUTE_MAX_TOOLS,
  ABSOLUTE_MAX_TRIALS,
  MAX_CONCURRENCY,
  MAX_REPEAT,
  MAX_TEMPERATURE,
  MIN_CONCURRENCY,
  MIN_REPEAT,
  MIN_TEMPERATURE,
} from '../core/eval/options.js'
import { isJsonObject } from '../core/json.js'
import type { ReportFormat, WhichtoolConfig } from '../config.js'
import type { Runtime } from '../runtime/types.js'

export const CONFIG_FILENAMES = [
  'whichtool.config.ts',
  'whichtool.config.mts',
  'whichtool.config.js',
  'whichtool.config.mjs',
  'whichtool.config.json',
] as const

type UnknownObject = Record<string, unknown>

const REPORT_FORMATS = new Set<ReportFormat>([
  'terminal',
  'json',
  'markdown',
  'html',
  'junit',
  'badge',
])

function invalid(source: string, path: string, message: string): never {
  throw new WhichtoolError('config/invalid', `${source}: ${path} ${message}`)
}

function object(value: unknown, source: string, path: string): UnknownObject {
  if (!isJsonObject(value)) invalid(source, path, 'must be an object.')
  return value as UnknownObject
}

function knownKeys(
  value: UnknownObject,
  allowed: readonly string[],
  source: string,
  path: string,
): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unknown !== undefined) invalid(source, `${path}.${unknown}`, 'is not a recognised option.')
}

function nonEmptyString(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(source, path, 'must be a non-empty string.')
  }
  return value
}

function optionalNonEmptyString(value: unknown, source: string, path: string): void {
  if (value !== undefined) nonEmptyString(value, source, path)
}

function finiteRange(value: unknown, min: number, max: number, source: string, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(source, path, `must be a finite number between ${min} and ${max}.`)
  }
}

function safeIntegerRange(
  value: unknown,
  min: number,
  max: number,
  source: string,
  path: string,
): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(source, path, `must be a safe integer between ${min} and ${max}.`)
  }
}

function stringRecord(value: unknown, source: string, path: string): void {
  const record = object(value, source, path)
  for (const [key, child] of Object.entries(record)) {
    if (typeof child !== 'string') invalid(source, `${path}.${key}`, 'must be a string.')
  }
}

function validateTarget(value: unknown, source: string): void {
  const target = object(value, source, 'target')
  const transport = target.transport
  if (transport === 'snapshot') {
    knownKeys(target, ['transport', 'path'], source, 'target')
    nonEmptyString(target.path, source, 'target.path')
    return
  }
  if (transport === 'http' || transport === 'legacy-sse') {
    knownKeys(target, ['transport', 'url', 'headers'], source, 'target')
    nonEmptyString(target.url, source, 'target.url')
    if (target.headers !== undefined) stringRecord(target.headers, source, 'target.headers')
    return
  }
  if (transport === 'stdio') {
    knownKeys(target, ['transport', 'command', 'args', 'env', 'cwd'], source, 'target')
    nonEmptyString(target.command, source, 'target.command')
    if (target.args !== undefined) {
      if (!Array.isArray(target.args)) invalid(source, 'target.args', 'must be an array.')
      for (const [index, argument] of target.args.entries()) {
        if (typeof argument !== 'string') {
          invalid(source, `target.args[${index}]`, 'must be a string.')
        }
      }
    }
    if (target.env !== undefined) stringRecord(target.env, source, 'target.env')
    optionalNonEmptyString(target.cwd, source, 'target.cwd')
    return
  }
  invalid(source, 'target.transport', 'must be snapshot, http, stdio, or legacy-sse.')
}

/** Runtime validation shared by JSON and JavaScript/TypeScript config modules. */
export function validateConfig(value: unknown, source = 'config'): WhichtoolConfig {
  const config = object(value, source, 'config')
  knownKeys(
    config,
    ['target', 'tasks', 'provider', 'trials', 'thresholds', 'report'],
    source,
    'config',
  )

  if (config.target !== undefined) validateTarget(config.target, source)
  optionalNonEmptyString(config.tasks, source, 'tasks')

  if (config.provider !== undefined) {
    const provider = object(config.provider, source, 'provider')
    knownKeys(provider, ['name', 'model', 'baseUrl'], source, 'provider')
    nonEmptyString(provider.name, source, 'provider.name')
    optionalNonEmptyString(provider.model, source, 'provider.model')
    optionalNonEmptyString(provider.baseUrl, source, 'provider.baseUrl')
  }

  if (config.trials !== undefined) {
    const trials = object(config.trials, source, 'trials')
    knownKeys(
      trials,
      [
        'repeat',
        'maxTrials',
        'maxTools',
        'permute',
        'temperature',
        'concurrency',
        'seed',
        'reasoningEffort',
      ],
      source,
      'trials',
    )
    if (trials.repeat !== undefined) {
      safeIntegerRange(trials.repeat, MIN_REPEAT, MAX_REPEAT, source, 'trials.repeat')
    }
    if (trials.maxTrials !== undefined) {
      safeIntegerRange(trials.maxTrials, 1, ABSOLUTE_MAX_TRIALS, source, 'trials.maxTrials')
    }
    if (trials.maxTools !== undefined) {
      safeIntegerRange(trials.maxTools, 1, ABSOLUTE_MAX_TOOLS, source, 'trials.maxTools')
    }
    if (trials.permute !== undefined && typeof trials.permute !== 'boolean') {
      invalid(source, 'trials.permute', 'must be a boolean.')
    }
    if (trials.temperature !== undefined) {
      finiteRange(
        trials.temperature,
        MIN_TEMPERATURE,
        MAX_TEMPERATURE,
        source,
        'trials.temperature',
      )
    }
    if (trials.concurrency !== undefined) {
      safeIntegerRange(
        trials.concurrency,
        MIN_CONCURRENCY,
        MAX_CONCURRENCY,
        source,
        'trials.concurrency',
      )
    }
    if (trials.seed !== undefined && !Number.isSafeInteger(trials.seed)) {
      invalid(source, 'trials.seed', 'must be a safe integer.')
    }
    optionalNonEmptyString(trials.reasoningEffort, source, 'trials.reasoningEffort')
  }

  if (config.thresholds !== undefined) {
    const thresholds = object(config.thresholds, source, 'thresholds')
    knownKeys(
      thresholds,
      ['minAccuracy', 'maxOverTrigger', 'maxContextTokens', 'maxErrorRate', 'minScored'],
      source,
      'thresholds',
    )
    for (const name of ['minAccuracy', 'maxOverTrigger', 'maxErrorRate'] as const) {
      if (thresholds[name] !== undefined)
        finiteRange(thresholds[name], 0, 1, source, `thresholds.${name}`)
    }
    if (thresholds.maxContextTokens !== undefined) {
      safeIntegerRange(
        thresholds.maxContextTokens,
        0,
        Number.MAX_SAFE_INTEGER,
        source,
        'thresholds.maxContextTokens',
      )
    }
    if (thresholds.minScored !== undefined) {
      safeIntegerRange(
        thresholds.minScored,
        1,
        Number.MAX_SAFE_INTEGER,
        source,
        'thresholds.minScored',
      )
    }
  }

  if (config.report !== undefined) {
    const report = object(config.report, source, 'report')
    knownKeys(report, ['formats', 'out'], source, 'report')
    if (report.formats !== undefined) {
      if (!Array.isArray(report.formats)) invalid(source, 'report.formats', 'must be an array.')
      for (const [index, format] of report.formats.entries()) {
        if (typeof format !== 'string' || !REPORT_FORMATS.has(format as ReportFormat)) {
          invalid(source, `report.formats[${index}]`, 'is not a supported report format.')
        }
      }
    }
    optionalNonEmptyString(report.out, source, 'report.out')
  }

  return config as WhichtoolConfig
}

async function loadJson(runtime: Runtime, path: string): Promise<WhichtoolConfig> {
  const text = await runtime.readTextFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new WhichtoolError(
      'config/invalid-json',
      `${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  return validateConfig(parsed, path)
}

async function loadModule(runtime: Runtime, path: string): Promise<WhichtoolConfig> {
  let module: unknown
  try {
    module = await runtime.importModule(path)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new WhichtoolError(
      'config/unloadable',
      `Cannot load ${path}: ${message}`,
      path.endsWith('.ts')
        ? 'Loading a TypeScript config needs Node >= 22.6 with type stripping, or Bun. A `whichtool.config.json` works everywhere.'
        : undefined,
    )
  }
  const exported = (module as { default?: unknown }).default ?? module
  if (!isJsonObject(exported as never)) {
    throw new WhichtoolError(
      'config/no-default-export',
      `${path} must default-export a config object.`,
      'Use `export default defineConfig({ ... })` from "whichtool/config".',
    )
  }
  return validateConfig(exported, path)
}

/**
 * Load `whichtool.config.*` from the working directory, or from an explicit path.
 *
 * A missing config is not an error: `whichtool inspect <snapshot.json>` has to work in a
 * directory with nothing set up, because that is the whole point of the free command
 * (SPEC §3.4).
 */
export async function loadConfig(
  runtime: Runtime,
  explicitPath?: string | undefined,
): Promise<WhichtoolConfig> {
  if (explicitPath !== undefined) {
    const absolute = runtime.resolve(explicitPath)
    if (!(await runtime.fileExists(absolute))) {
      throw new WhichtoolError('config/not-found', `No config file at ${absolute}.`)
    }
    return absolute.endsWith('.json') ? loadJson(runtime, absolute) : loadModule(runtime, absolute)
  }

  for (const filename of CONFIG_FILENAMES) {
    const absolute = runtime.resolve(filename)
    if (!(await runtime.fileExists(absolute))) continue
    return filename.endsWith('.json') ? loadJson(runtime, absolute) : loadModule(runtime, absolute)
  }

  return {}
}
