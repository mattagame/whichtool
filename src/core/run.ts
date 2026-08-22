import {
  computeMetrics,
  proportion,
  thinlyMeasuredTools,
  type Proportion,
  type RunMetrics,
} from './eval/metrics.js'
import { assertConcurrency } from './eval/options.js'
import { WhichtoolError } from './errors.js'
import type { ScoredTrial } from './eval/scorer.js'
import type { TrialPlan } from './eval/planner.js'
import type { ProviderCapabilities } from './providers/types.js'
import { sortDiagnostics, type ThresholdCheck } from './inspect.js'
import type { Task, TaskSet } from './tasks/schema.js'
import type { Diagnostic, Surface, SurfaceSource, SurfaceTokens } from './types.js'
import { WHICHTOOL_VERSION } from '../version.js'

export const RUN_SCHEMA_VERSION = 'whichtool.run/2'

export interface Reproducibility {
  whichtoolVersion: string
  provider: string
  model: string
  endpoint: string | null
  /** Non-secret digest of request construction options used for comparability. */
  requestFingerprint: string | null
  providerCapabilities: ProviderCapabilities
  temperature: number
  /**
   * The provider-side reasoning knob, when one was set. Recorded because it changes what
   * was measured: a reasoning model asked not to reason is a different subject.
   */
  reasoningEffort: string | null

  seed: number
  repeat: number
  permuted: boolean
  concurrency: number
  surfaceHash: string
  taskSetVersion: number
  taskSetSource: string

  taskSetSurface: string | null
}

export interface RunReport {
  schemaVersion: string
  reproducibility: Reproducibility
  target: SurfaceSource
  tasks: {
    inFile: number
    selected: number
    distractors: number
    only: string[]
    skip: string[]

    list: Array<{ id: string; prompt: string; expected: string | null; tags: string[] }>
  }
  metrics: RunMetrics
  contextCost: SurfaceTokens
  diagnostics: Diagnostic[]
  thresholds: RunThresholdCheck[]
  /** Whether every configured quality threshold passed. */
  thresholdsOk: boolean
  /** Provider/run health, kept separate from model-quality thresholds for automation. */
  execution: RunExecutionStatus
  ok: boolean

  durationMs: number
  trials: ScoredTrial[]
}

export interface RunThresholdCheck extends ThresholdCheck {
  name: 'minAccuracy' | 'maxOverTrigger' | 'maxContextTokens'
}

export interface RunThresholds {
  minAccuracy?: number | undefined
  maxOverTrigger?: number | undefined
  maxContextTokens?: number | undefined
  maxErrorRate?: number | undefined
  minScored?: number | undefined
}

export interface RunExecutionStatus {
  ok: boolean
  planned: number
  completed: number
  scored: number
  errored: number
  errorRate: Proportion
  maxErrorRate: number
  minScored: number
}

export const DEFAULT_MAX_ERROR_RATE = 0.1
export const DEFAULT_MIN_SCORED = 1

export interface BuildRunReportInput {
  surface: Surface
  taskSet: TaskSet
  selected: readonly Task[]
  plan: TrialPlan
  trials: readonly ScoredTrial[]
  durationMs: number
  provider: {
    id: string
    model: string
    endpoint: string | null
    behaviorFingerprint?: string | null | undefined
    capabilities: ProviderCapabilities
  }
  temperature: number
  reasoningEffort?: string | undefined
  concurrency: number
  thresholds?: RunThresholds
  only?: readonly string[]
  skip?: readonly string[]

  upstreamDiagnostics?: readonly Diagnostic[]
}

export const POSITION_SPREAD_WARNING = 0.2

export function validateRunThresholds(thresholds: RunThresholds): void {
  for (const [name, value] of [
    ['minAccuracy', thresholds.minAccuracy],
    ['maxOverTrigger', thresholds.maxOverTrigger],
    ['maxErrorRate', thresholds.maxErrorRate],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new WhichtoolError(
        'run/invalid-threshold',
        `${name} must be a finite number between 0 and 1; received ${String(value)}.`,
      )
    }
  }
  if (
    thresholds.maxContextTokens !== undefined &&
    (!Number.isSafeInteger(thresholds.maxContextTokens) || thresholds.maxContextTokens < 0)
  ) {
    throw new WhichtoolError(
      'run/invalid-threshold',
      `maxContextTokens must be a non-negative safe integer; received ${String(thresholds.maxContextTokens)}.`,
    )
  }
  if (
    thresholds.minScored !== undefined &&
    (!Number.isSafeInteger(thresholds.minScored) || thresholds.minScored < 1)
  ) {
    throw new WhichtoolError(
      'run/invalid-threshold',
      `minScored must be a positive safe integer; received ${String(thresholds.minScored)}.`,
    )
  }
}

export function buildRunReport(input: BuildRunReportInput): RunReport {
  const wanted = input.thresholds ?? {}
  validateRunThresholds(wanted)
  const metrics = computeMetrics(
    input.trials,
    input.selected,
    input.surface.tools,
    input.surface.tokens.byTool,
  )

  const diagnostics: Diagnostic[] = [...(input.upstreamDiagnostics ?? [])]

  const capabilities = input.provider.capabilities
  if (!capabilities.temperatureZero && input.temperature === 0) {
    diagnostics.push({
      code: 'run/temperature-not-honoured',
      severity: 'warning',
      message: `\`${input.provider.id}\` does not honour temperature 0, so repeated trials vary for reasons that have nothing to do with your surface. Read the intervals, not the point estimates.`,
    })
  }
  if (!capabilities.seed) {
    diagnostics.push({
      code: 'run/no-seed-support',
      severity: 'info',
      message: `\`${input.provider.id}\` accepts no seed, so this run is not bit-reproducible. Comparability rests on \`repeat\` and the reported intervals instead.`,
    })
  }

  const thin = thinlyMeasuredTools(metrics)
  if (thin.length > 0) {
    diagnostics.push({
      code: 'run/thin-measurement',
      severity: 'warning',
      message: `${thin.length} tools rest on fewer than ${metrics.minTrialsPerTool} trials, so their accuracy carries an interval too wide to act on. Add tasks or raise --repeat before drawing a conclusion about: ${thin.join(', ')}.`,
      tools: thin,
    })
  }
  if (metrics.overTrigger.denominator === 0) {
    diagnostics.push({
      code: 'run/no-distractor-trials',
      severity: 'warning',
      message:
        'No distractor was run, so the over-trigger rate is unmeasured. Abstention and over-triggering trade off against each other, and reading one without the other is how a surface gets tuned in the wrong direction.',
    })
  }
  if (metrics.multiCallRate.numerator > 0) {
    const firstChoiceMatches = input.trials.filter(
      (trial) =>
        trial.verdict === 'unexpected-additional-calls' &&
        trial.expected !== null &&
        trial.pick === trial.expected,
    ).length
    diagnostics.push({
      code: 'run/unexpected-additional-calls',
      severity: 'warning',
      message:
        `${metrics.multiCallRate.numerator} of ${metrics.multiCallRate.denominator} scored trials proposed more than one tool call in a single selection turn. ` +
        `${firstChoiceMatches} had the expected tool first, but are not counted as correct because the additional calls would change agent behaviour. No tool was executed.`,
      detail: {
        trials: metrics.multiCallRate.numerator,
        denominator: metrics.multiCallRate.denominator,
        firstChoiceMatches,
      },
    })
  }
  // The token figure whichtool prints is a structural estimate. Providers report what they
  // actually counted, and whichtool receives that on every trial — so it can check its own
  // arithmetic instead of asking to be believed. Silence here means the estimate held.
  const counted = input.trials
    .map((trial) => trial.usage?.promptTokens)
    .filter((tokens): tokens is number => typeof tokens === 'number')
  if (counted.length > 0) {
    const promptChars = input.selected.reduce((sum, task) => sum + task.prompt.length, 0)
    const estimate =
      input.surface.tokens.total +
      (input.selected.length === 0 ? 0 : Math.round(promptChars / input.selected.length / 4))
    const actual = Math.round(counted.reduce((sum, n) => sum + n, 0) / counted.length)
    const ratio = actual === 0 ? 0 : estimate / actual
    if (ratio >= 1.25 || ratio <= 0.8) {
      diagnostics.push({
        code: 'run/estimate-drift',
        severity: 'info',
        message: `The surface estimate of ~${estimate} tokens per trial is ${ratio.toFixed(1)}x what \`${input.provider.id}\` actually counted (~${actual}). Estimates compare tools against each other; for a bill, read the provider number.`,
        detail: { estimatedPerTrial: estimate, countedPerTrial: actual, trials: counted.length },
      })
    }
  }

  const executionPlanned = input.plan.trials.length
  const executionCompleted = input.trials.length
  const executionScored = metrics.trials.scored
  const executionErrored = Math.max(0, executionPlanned - executionScored)
  const maxErrorRate = wanted.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE
  const minScored = wanted.minScored ?? DEFAULT_MIN_SCORED
  const errorRate = proportion(executionErrored, executionPlanned)
  const executionOk =
    executionPlanned > 0 &&
    executionCompleted === executionPlanned &&
    executionScored >= minScored &&
    errorRate.value !== null &&
    errorRate.value <= maxErrorRate

  if (metrics.trials.errored > 0) {
    // Carry one failure's own words. A run where every trial failed otherwise reports only
    // that it failed, and the reason sits in the saved JSON where nobody looks first.
    const failure = input.trials.find((trial) => trial.error !== undefined)?.error
    const because =
      failure === undefined
        ? ''
        : ` First failure: ${failure.message}${failure.hint === undefined ? '' : ` ${failure.hint}`}`
    diagnostics.push({
      code: 'run/errored-trials',
      severity: executionOk ? 'info' : 'error',
      message: `${metrics.trials.errored} of ${metrics.trials.planned} trials failed at the provider and are excluded from every rate above. They are not counted as the model choosing nothing.${because}`,
      detail: {
        errored: metrics.trials.errored,
        planned: metrics.trials.planned,
        maxErrorRate,
        minScored,
      },
    })
  }
  if (executionCompleted !== executionPlanned) {
    diagnostics.push({
      code: 'run/incomplete-plan',
      severity: 'error',
      message: `${executionCompleted} of ${executionPlanned} planned trials completed. An incomplete run cannot be used as a passing measurement.`,
      detail: { completed: executionCompleted, planned: executionPlanned },
    })
  }
  if (executionScored < minScored && metrics.trials.errored === 0) {
    diagnostics.push({
      code: 'run/insufficient-scored-trials',
      severity: 'error',
      message: `${executionScored} trials were scored; at least ${minScored} are required for a valid run.`,
      detail: { scored: executionScored, minScored },
    })
  }

  // position sensitivity
  if (metrics.position.spread !== null && metrics.position.spread >= POSITION_SPREAD_WARNING) {
    diagnostics.push({
      code: 'run/position-sensitive',
      severity: 'warning',
      message: `The same task swings by ${(metrics.position.spread * 100).toFixed(0)} points depending on where the expected tool sat in the list, averaged over ${metrics.position.comparableTasks} tasks tried at more than one position. That is the model going by position rather than by description, which means the descriptions are not doing the work.`,
      detail: {
        spread: Number(metrics.position.spread.toFixed(4)),
        tasks: metrics.position.comparableTasks,
      },
    })
  }
  if (!input.plan.permuted) {
    diagnostics.push({
      code: 'run/not-permuted',
      severity: 'warning',
      message:
        'Tool order was not permuted between trials, so any accuracy here includes an unknown contribution from list position. Use this only to reproduce a specific ordering, never to judge a surface.',
    })
  }

  // the headline confusions
  for (const pair of metrics.confusionPairs.slice(0, 5)) {
    diagnostics.push({
      code: 'run/confusion-pair',
      // The absolute swap count grows with repeat/task-set size, so it is useful evidence but
      // not a scale-independent quality gate. Users who need a machine gate should configure
      // one of the measured rate thresholds instead.
      severity: 'warning',
      message: `\`${pair.tools[0]}\` and \`${pair.tools[1]}\` were swapped ${pair.swaps} times across ${pair.rate.denominator} trials where one of them was expected.`,
      tools: [...pair.tools],
      detail: { swaps: pair.swaps, denominator: pair.rate.denominator },
    })
  }

  // thresholds
  const thresholds: RunThresholdCheck[] = []
  if (wanted.minAccuracy !== undefined) {
    const actual = metrics.accuracy.value
    thresholds.push({
      name: 'minAccuracy',
      limit: wanted.minAccuracy,
      actual: actual ?? 0,
      // An unmeasured accuracy fails the gate. Passing CI on no evidence is worse than
      // failing it (SPEC §3.5).
      ok: actual !== null && actual >= wanted.minAccuracy,
    })
  }
  if (wanted.maxOverTrigger !== undefined) {
    const actual = metrics.overTrigger.value
    thresholds.push({
      name: 'maxOverTrigger',
      limit: wanted.maxOverTrigger,
      actual: actual ?? 1,
      ok: actual !== null && actual <= wanted.maxOverTrigger,
    })
  }
  if (wanted.maxContextTokens !== undefined) {
    thresholds.push({
      name: 'maxContextTokens',
      limit: wanted.maxContextTokens,
      actual: input.surface.tokens.total,
      ok: input.surface.tokens.total <= wanted.maxContextTokens,
    })
  }

  for (const check of thresholds) {
    if (check.ok) continue
    diagnostics.push({
      code: `threshold/${check.name}`,
      severity: 'error',
      message:
        check.name === 'maxContextTokens'
          ? `Surface costs ~${check.actual} tokens, over the ${check.limit}-token budget.`
          : `${check.name}: ${check.actual.toFixed(3)} against a limit of ${check.limit}.`,
      detail: { limit: check.limit, actual: Number(check.actual.toFixed(4)) },
    })
  }

  const thresholdsOk = thresholds.every((check) => check.ok)
  const diagnosticsOk = !diagnostics.some((diagnostic) => diagnostic.severity === 'error')
  const execution: RunExecutionStatus = {
    ok: executionOk,
    planned: executionPlanned,
    completed: executionCompleted,
    scored: executionScored,
    errored: executionErrored,
    errorRate,
    maxErrorRate,
    minScored,
  }

  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    reproducibility: {
      whichtoolVersion: WHICHTOOL_VERSION,
      provider: input.provider.id,
      model: input.provider.model,
      endpoint: input.provider.endpoint,
      requestFingerprint: input.provider.behaviorFingerprint ?? null,
      providerCapabilities: capabilities,
      temperature: input.temperature,
      reasoningEffort: input.reasoningEffort ?? null,
      seed: input.plan.seed,
      repeat: input.plan.repeat,
      permuted: input.plan.permuted,
      concurrency: input.concurrency,
      surfaceHash: input.surface.hash,
      taskSetVersion: input.taskSet.version,
      taskSetSource: input.taskSet.source,
      taskSetSurface: input.taskSet.surface,
    },
    target: input.surface.source,
    tasks: {
      inFile: input.taskSet.tasks.length,
      selected: input.selected.length,
      distractors: input.selected.filter((task) => task.expected === null).length,
      only: [...(input.only ?? [])],
      skip: [...(input.skip ?? [])],
      list: input.selected.map((task) => ({
        id: task.id,
        prompt: task.prompt,
        expected: task.expected,
        tags: [...task.tags],
      })),
    },
    metrics,
    contextCost: input.surface.tokens,
    diagnostics: sortDiagnostics(diagnostics),
    thresholds,
    thresholdsOk,
    execution,
    ok: execution.ok && thresholdsOk && diagnosticsOk,
    durationMs: input.durationMs,
    trials: [...input.trials],
  }
}

export interface DryRunEstimate {
  trials: number
  /** Tokens sent per trial: the whole tool surface plus the prompt. */
  promptTokensPerTrial: number
  totalPromptTokens: number
  /** Null when no measured latency is available to extrapolate from. */
  estimatedSeconds: number | null
  concurrency: number
}

/**
 * What a run would cost, without calling the model (SPEC §6).
 *
 * The time estimate matters as much as the token one: against a local reasoning model a
 * trial can take the better part of a minute, and a user deserves to learn that before
 * starting rather than forty minutes in.
 */
export function estimateRun(
  plan: TrialPlan,
  surface: Surface,
  tasks: readonly Task[],
  options: { concurrency?: number; secondsPerTrial?: number | undefined } = {},
): DryRunEstimate {
  if (plan.trials.length === 0) {
    throw new WhichtoolError(
      'trials/empty-plan',
      'Cannot estimate a trial plan containing zero trials.',
    )
  }
  const concurrency = assertConcurrency(options.concurrency ?? 1)
  if (
    options.secondsPerTrial !== undefined &&
    (!Number.isFinite(options.secondsPerTrial) || options.secondsPerTrial < 0)
  ) {
    throw new WhichtoolError(
      'trials/invalid-seconds-per-trial',
      `secondsPerTrial must be a non-negative finite number; received ${String(options.secondsPerTrial)}.`,
    )
  }
  const promptTokens = tasks.reduce((sum, task) => sum + Math.ceil(task.prompt.length / 4), 0)
  const averagePromptTokens = tasks.length === 0 ? 0 : Math.round(promptTokens / tasks.length)
  const perTrial = surface.tokens.total + averagePromptTokens

  return {
    trials: plan.trials.length,
    promptTokensPerTrial: perTrial,
    totalPromptTokens: perTrial * plan.trials.length,
    estimatedSeconds:
      options.secondsPerTrial === undefined
        ? null
        : Math.ceil((plan.trials.length * options.secondsPerTrial) / concurrency),
    concurrency,
  }
}
