import type { Proportion } from './eval/metrics.js'
import type { RunReport } from './run.js'
import type { Diagnostic } from './types.js'
export { parseRunReport } from './report/parse-run.js'

export const DIFF_SCHEMA_VERSION = 'whichtool.diff/2'

export const PAIRED_SIGNIFICANCE_LEVEL = 0.05

export interface ToolDelta {
  tool: string
  before: Proportion | null
  after: Proportion | null

  delta: number | null

  distinguishable: boolean
  paired: PairedComparison
}

export interface PairedComparison {
  /** Trials present and successfully scored in both runs. */
  matched: number
  /** Trials that failed in the base and passed in the head. */
  improved: number
  /** Trials that passed in the base and failed in the head. */
  regressed: number
  /** Eligible base trials omitted because either side was missing or errored. */
  excluded: number
  /** Exact two-sided sign-test p-value over discordant pairs. */
  pValue: number
  distinguishable: boolean
}

export interface ConfusionDelta {
  tools: [string, string]
  swaps: number
  denominator: number
  introduced: number
  resolved: number
  pValue: number
  distinguishable: boolean
}

export interface RunDiff {
  schemaVersion: string
  base: { source: string; provider: string; model: string; surfaceHash: string; repeat: number }
  head: { source: string; provider: string; model: string; surfaceHash: string; repeat: number }

  comparable: boolean
  incomparable: string[]
  accuracy: {
    before: Proportion
    after: Proportion
    delta: number | null
    distinguishable: boolean
    paired: PairedComparison
  }
  overTrigger: {
    before: Proportion
    after: Proportion
    delta: number | null
    distinguishable: boolean
    paired: PairedComparison
  }
  multiCall: {
    before: Proportion
    after: Proportion
    delta: number | null
    distinguishable: boolean
    paired: PairedComparison
  }
  contextTokens: { before: number; after: number; delta: number }
  byTool: ToolDelta[]

  newConfusions: ConfusionDelta[]

  resolvedConfusions: ConfusionDelta[]
  diagnostics: Diagnostic[]

  ok: boolean
}

function logSumExp(values: readonly number[]): number {
  if (values.length === 0) return Number.NEGATIVE_INFINITY
  const maximum = Math.max(...values)
  if (!Number.isFinite(maximum)) return maximum
  return maximum + Math.log(values.reduce((sum, value) => sum + Math.exp(value - maximum), 0))
}

/** Exact two-sided sign test for paired binary outcomes. */
export function pairedSignPValue(improved: number, regressed: number): number {
  const discordant = improved + regressed
  if (discordant === 0) return 1
  const tail = Math.min(improved, regressed)
  const logProbabilities: number[] = [-discordant * Math.log(2)]
  for (let successes = 1; successes <= tail; successes += 1) {
    logProbabilities.push(
      (logProbabilities[successes - 1] as number) +
        Math.log(discordant - successes + 1) -
        Math.log(successes),
    )
  }
  return Math.min(1, 2 * Math.exp(logSumExp(logProbabilities)))
}

function trialKey(trial: RunReport['trials'][number]): string {
  return `${trial.taskId}\u0000${trial.trialIndex}`
}

function pairedComparison(
  base: RunReport,
  head: RunReport,
  eligible: (trial: RunReport['trials'][number]) => boolean,
  passes: (trial: RunReport['trials'][number]) => boolean,
): PairedComparison {
  const headByTrial = new Map(head.trials.map((trial) => [trialKey(trial), trial]))
  let matched = 0
  let improved = 0
  let regressed = 0
  let excluded = 0

  for (const before of base.trials) {
    if (!eligible(before)) continue
    const after = headByTrial.get(trialKey(before))
    if (after === undefined || before.verdict === 'error' || after.verdict === 'error') {
      excluded += 1
      continue
    }
    matched += 1
    const beforePasses = passes(before)
    const afterPasses = passes(after)
    if (!beforePasses && afterPasses) improved += 1
    if (beforePasses && !afterPasses) regressed += 1
  }

  const pValue = pairedSignPValue(improved, regressed)
  return {
    matched,
    improved,
    regressed,
    excluded,
    pValue,
    distinguishable: improved + regressed > 0 && pValue <= PAIRED_SIGNIFICANCE_LEVEL,
  }
}

function delta(before: Proportion, after: Proportion): number | null {
  if (before.value === null || after.value === null) return null
  return after.value - before.value
}

function comparabilityProblems(base: RunReport, head: RunReport): string[] {
  const problems: string[] = []
  const a = base.reproducibility
  const b = head.reproducibility

  if (!base.execution.ok || !head.execution.ok) {
    problems.push('at least one run did not complete with enough successfully scored trials.')
  }

  if (a.provider !== b.provider || a.model !== b.model) {
    problems.push(
      `different model: ${a.provider}/${a.model} against ${b.provider}/${b.model}. Changing the model makes this a different measurement, not a delta.`,
    )
  }
  if (a.endpoint !== b.endpoint) {
    problems.push(
      `different endpoint: ${a.endpoint ?? '(none)'} against ${b.endpoint ?? '(none)'}.`,
    )
  }
  if (a.requestFingerprint !== b.requestFingerprint) {
    problems.push(
      'different provider request construction. Headers or provider transport options changed, so the model did not receive the same kind of request.',
    )
  }
  if (
    a.providerCapabilities.seed !== b.providerCapabilities.seed ||
    a.providerCapabilities.temperatureZero !== b.providerCapabilities.temperatureZero ||
    a.providerCapabilities.logprobs !== b.providerCapabilities.logprobs ||
    a.providerCapabilities.disableThinking !== b.providerCapabilities.disableThinking
  ) {
    problems.push('different provider capabilities.')
  }
  if (a.temperature !== b.temperature) {
    problems.push(`different temperature: ${a.temperature} against ${b.temperature}.`)
  }
  if ((a.reasoningEffort ?? null) !== (b.reasoningEffort ?? null)) {
    problems.push(
      `different reasoning effort: ${a.reasoningEffort ?? '(unset)'} against ${b.reasoningEffort ?? '(unset)'}. How much a model reasons before choosing is part of what is being measured.`,
    )
  }
  if (a.seed !== b.seed) {
    problems.push(`different seed: ${a.seed} against ${b.seed}.`)
  }
  if (a.repeat !== b.repeat) {
    problems.push(
      `different repeat count: ${a.repeat} against ${b.repeat}. The intervals are not the same width, so a delta reads as larger or smaller than it is.`,
    )
  }
  if (a.permuted !== b.permuted) {
    problems.push(
      `one run permuted tool order and the other did not, so one of the two includes a position artifact the other does not.`,
    )
  }
  if (a.taskSetVersion !== b.taskSetVersion) {
    problems.push(
      `different task-set schema version: ${a.taskSetVersion} against ${b.taskSetVersion}.`,
    )
  }
  const measuredTasks = (run: RunReport): string =>
    JSON.stringify(
      run.tasks.list
        .map(({ id, prompt, expected }) => ({ id, prompt, expected }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    )
  if (measuredTasks(base) !== measuredTasks(head)) {
    problems.push('different selected tasks, prompts or expected tools.')
  }
  return problems
}

export interface DiffOptions {
  /** Fail when a distinguishable paired accuracy drop exceeds this fraction. */
  maxAccuracyDrop?: number | undefined
}

export function diffRuns(base: RunReport, head: RunReport, options: DiffOptions = {}): RunDiff {
  const diagnostics: Diagnostic[] = []
  const incomparable = comparabilityProblems(base, head)
  const comparable = incomparable.length === 0

  for (const problem of incomparable) {
    diagnostics.push({
      code: 'diff/incomparable',
      severity: 'error',
      message: `These runs are not comparable: ${problem}`,
    })
  }

  if (base.reproducibility.surfaceHash === head.reproducibility.surfaceHash) {
    diagnostics.push({
      code: 'diff/same-surface',
      severity: 'info',
      message:
        'Both runs measured the same surface hash, so any difference reflects sampling or provider variability rather than a surface change.',
    })
  }

  // per tool
  const baseByTool = new Map(base.metrics.byTool.map((tool) => [tool.tool, tool]))
  const headByTool = new Map(head.metrics.byTool.map((tool) => [tool.tool, tool]))
  const allTools = [...new Set([...baseByTool.keys(), ...headByTool.keys()])].sort()

  const byTool: ToolDelta[] = allTools.map((name) => {
    const before = baseByTool.get(name)?.accuracy ?? null
    const after = headByTool.get(name)?.accuracy ?? null
    if (before === null || after === null) {
      return {
        tool: name,
        before,
        after,
        delta: null,
        distinguishable: false,
        paired: pairedComparison(
          base,
          head,
          (trial) => trial.expected === name,
          (trial) => trial.verdict === 'correct',
        ),
      }
    }
    const paired = pairedComparison(
      base,
      head,
      (trial) => trial.expected === name,
      (trial) => trial.verdict === 'correct',
    )
    return {
      tool: name,
      before,
      after,
      delta: delta(before, after),
      distinguishable: paired.distinguishable,
      paired,
    }
  })
  byTool.sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0) || (a.tool < b.tool ? -1 : 1))

  for (const tool of byTool) {
    if (tool.before !== null && tool.after === null) {
      diagnostics.push({
        code: 'diff/tool-removed',
        severity: 'info',
        message: `\`${tool.tool}\` is measured in the base run but not in the head run.`,
        tool: tool.tool,
      })
    }
    if (tool.before === null && tool.after !== null) {
      diagnostics.push({
        code: 'diff/tool-added',
        severity: 'info',
        message: `\`${tool.tool}\` is new in the head run.`,
        tool: tool.tool,
      })
    }
    if (tool.delta !== null && tool.delta < 0 && tool.distinguishable) {
      diagnostics.push({
        code: 'diff/tool-regressed',
        severity: 'warning',
        message: `\`${tool.tool}\` fell by ${Math.abs(Math.round(tool.delta * 100))} points; the paired comparison has ${tool.paired.regressed} regressions against ${tool.paired.improved} improvements (p=${tool.paired.pValue.toFixed(4)}).`,
        tool: tool.tool,
        detail: { delta: Number(tool.delta.toFixed(4)) },
      })
    }
  }

  // confusion pairs
  const key = (tools: readonly string[]): string => [...tools].sort().join(' <-> ')
  const basePairs = new Map(base.metrics.confusionPairs.map((pair) => [key(pair.tools), pair]))
  const headPairs = new Map(head.metrics.confusionPairs.map((pair) => [key(pair.tools), pair]))

  const confusionDelta = (tools: [string, string], swaps: number, denominator: number) => {
    const id = key(tools)
    const beforeByTrial = new Map(base.trials.map((trial) => [trialKey(trial), trial]))
    let introduced = 0
    let resolved = 0
    let matched = 0
    const confusionOf = (trial: RunReport['trials'][number]): string | null =>
      trial.verdict === 'wrong-tool' && trial.expected !== null && trial.pick !== null
        ? key([trial.expected, trial.pick])
        : null
    for (const after of head.trials) {
      if (after.expected !== tools[0] && after.expected !== tools[1]) continue
      const before = beforeByTrial.get(trialKey(after))
      if (before === undefined || before.verdict === 'error' || after.verdict === 'error') continue
      matched += 1
      const was = confusionOf(before) === id
      const is = confusionOf(after) === id
      if (!was && is) introduced += 1
      if (was && !is) resolved += 1
    }
    const pValue = pairedSignPValue(introduced, resolved)
    return {
      tools,
      swaps,
      denominator: Math.min(denominator, matched),
      introduced,
      resolved,
      pValue,
      distinguishable: introduced + resolved > 0 && pValue <= PAIRED_SIGNIFICANCE_LEVEL,
    } satisfies ConfusionDelta
  }

  const newConfusions = [...headPairs]
    .filter(([id]) => !basePairs.has(id))
    .map(([, pair]) => confusionDelta(pair.tools, pair.swaps, pair.rate.denominator))
  const resolvedConfusions = [...basePairs]
    .filter(([id]) => !headPairs.has(id))
    .map(([, pair]) => confusionDelta(pair.tools, pair.swaps, pair.rate.denominator))

  for (const pair of newConfusions) {
    diagnostics.push({
      code: 'diff/new-confusion',
      severity: pair.distinguishable ? 'error' : 'warning',
      message: pair.distinguishable
        ? `\`${pair.tools[0]}\` and \`${pair.tools[1]}\` became a confusion in ${pair.introduced} paired trials and resolved in ${pair.resolved} (p=${pair.pValue.toFixed(4)}).`
        : `\`${pair.tools[0]}\` and \`${pair.tools[1]}\` appeared as a new confusion, but the paired evidence is inconclusive (${pair.introduced} introduced, ${pair.resolved} resolved; p=${pair.pValue.toFixed(4)}).`,
      tools: [...pair.tools],
      detail: {
        swaps: pair.swaps,
        denominator: pair.denominator,
        introduced: pair.introduced,
        resolved: pair.resolved,
        pValue: Number(pair.pValue.toFixed(6)),
      },
    })
  }
  for (const pair of resolvedConfusions) {
    diagnostics.push({
      code: 'diff/resolved-confusion',
      severity: 'info',
      message: `\`${pair.tools[0]}\` and \`${pair.tools[1]}\` are no longer confused.`,
      tools: [...pair.tools],
    })
  }

  const accuracyDelta = delta(base.metrics.accuracy, head.metrics.accuracy)
  const accuracyPaired = pairedComparison(
    base,
    head,
    (trial) => trial.expected !== null,
    (trial) => trial.verdict === 'correct',
  )
  const accuracyDistinguishable = accuracyPaired.distinguishable
  const overTriggerDelta = delta(base.metrics.overTrigger, head.metrics.overTrigger)
  const overTriggerPaired = pairedComparison(
    base,
    head,
    (trial) => trial.expected === null,
    (trial) => trial.verdict !== 'over-triggered',
  )
  const multiCallDelta = delta(base.metrics.multiCallRate, head.metrics.multiCallRate)
  const multiCallPaired = pairedComparison(
    base,
    head,
    () => true,
    (trial) => !trial.unexpectedAdditionalCalls,
  )
  const multiCallRegressed =
    multiCallDelta !== null && multiCallDelta > 0 && multiCallPaired.distinguishable

  if (multiCallRegressed) {
    diagnostics.push({
      code: 'diff/multi-call-regressed',
      severity: 'error',
      message: `Unexpected multi-call behaviour increased by ${Math.round(multiCallDelta * 100)} points; ${multiCallPaired.regressed} paired trials regressed against ${multiCallPaired.improved} improvements (p=${multiCallPaired.pValue.toFixed(4)}).`,
      detail: {
        delta: Number(multiCallDelta.toFixed(4)),
        regressed: multiCallPaired.regressed,
        improved: multiCallPaired.improved,
        pValue: Number(multiCallPaired.pValue.toFixed(6)),
      },
    })
  }

  if (accuracyDelta !== null && !accuracyDistinguishable && accuracyDelta !== 0) {
    diagnostics.push({
      code: 'diff/inconclusive',
      severity: 'info',
      message: `Overall accuracy moved by ${Math.round(accuracyDelta * 100)} points, but the paired comparison is inconclusive (${accuracyPaired.regressed} regressions, ${accuracyPaired.improved} improvements; p=${accuracyPaired.pValue.toFixed(4)}).`,
    })
  }

  const drop = accuracyDelta === null ? 0 : -accuracyDelta
  const gated = options.maxAccuracyDrop
  const regressed =
    gated !== undefined && accuracyDelta !== null && drop > gated && accuracyDistinguishable
  if (regressed) {
    diagnostics.push({
      code: 'threshold/maxAccuracyDrop',
      severity: 'error',
      message: `Accuracy dropped by ${Math.round(drop * 100)} points, past the ${Math.round(gated * 100)}-point limit; the paired comparison is significant (p=${accuracyPaired.pValue.toFixed(4)}).`,
    })
  }

  const before = base.contextCost.total
  const after = head.contextCost.total

  return {
    schemaVersion: DIFF_SCHEMA_VERSION,
    base: {
      source: base.reproducibility.taskSetSource,
      provider: base.reproducibility.provider,
      model: base.reproducibility.model,
      surfaceHash: base.reproducibility.surfaceHash,
      repeat: base.reproducibility.repeat,
    },
    head: {
      source: head.reproducibility.taskSetSource,
      provider: head.reproducibility.provider,
      model: head.reproducibility.model,
      surfaceHash: head.reproducibility.surfaceHash,
      repeat: head.reproducibility.repeat,
    },
    comparable,
    incomparable,
    accuracy: {
      before: base.metrics.accuracy,
      after: head.metrics.accuracy,
      delta: accuracyDelta,
      distinguishable: accuracyDistinguishable,
      paired: accuracyPaired,
    },
    overTrigger: {
      before: base.metrics.overTrigger,
      after: head.metrics.overTrigger,
      delta: overTriggerDelta,
      distinguishable: overTriggerPaired.distinguishable,
      paired: overTriggerPaired,
    },
    multiCall: {
      before: base.metrics.multiCallRate,
      after: head.metrics.multiCallRate,
      delta: multiCallDelta,
      distinguishable: multiCallPaired.distinguishable,
      paired: multiCallPaired,
    },
    contextTokens: { before, after, delta: after - before },
    byTool,
    newConfusions,
    resolvedConfusions,
    diagnostics,
    ok:
      comparable &&
      !regressed &&
      !multiCallRegressed &&
      !newConfusions.some((pair) => pair.distinguishable),
  }
}
