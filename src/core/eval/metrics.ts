import type { NormalizedTool } from '../types.js'
import type { Task } from '../tasks/schema.js'
import type { ScoredTrial, Verdict } from './scorer.js'

export interface Proportion {
  numerator: number
  denominator: number

  /** Null when the denominator is zero; JSON and TypeScript expose the same wire value. */
  value: number | null
  /** Wilson 95% interval, or null when there is nothing to compute it from. */
  ci95: [number, number] | null
}

const Z95 = 1.959963984540054

/**
 * Wilson score interval. Chosen over the normal approximation because it stays inside
 * [0, 1] and stays sane at the small n a hand-written task set actually has.
 */
export function proportion(numerator: number, denominator: number): Proportion {
  if (denominator <= 0) {
    return { numerator, denominator, value: null, ci95: null }
  }
  const p = numerator / denominator
  const z2 = Z95 * Z95
  const denom = 1 + z2 / denominator
  const centre = (p + z2 / (2 * denominator)) / denom
  const half =
    (Z95 * Math.sqrt((p * (1 - p)) / denominator + z2 / (4 * denominator * denominator))) / denom
  return {
    numerator,
    denominator,
    value: p,
    ci95: [Math.max(0, centre - half), Math.min(1, centre + half)],
  }
}

export interface ToolMetrics {
  tool: string

  /** Correct single-call selections for this expected tool. */
  accuracy: Proportion

  confusedWith: Array<{ tool: string; count: number }>
  abstained: number
  phantom: number
  errors: number

  argumentAccuracy: Proportion
  hallucinatedParameters: number

  contextTokens: number
}

export interface ConfusionPair {
  tools: [string, string]

  swaps: number

  rate: Proportion
  aChosenWhenBExpected: number
  bChosenWhenAExpected: number
}

export interface PositionBucket {
  position: number
  accuracy: Proportion
}

export interface RunMetrics {
  trials: {
    planned: number

    scored: number
    errored: number
  }

  accuracy: Proportion
  abstention: Proportion
  overTrigger: Proportion
  phantom: Proportion
  /** Trials where a single selection turn proposed more than one tool call. */
  multiCallRate: Proportion

  clarification: Proportion
  byTool: ToolMetrics[]

  confusionMatrix: Record<string, Record<string, number>>
  confusionPairs: ConfusionPair[]
  position: {
    buckets: PositionBucket[]

    spread: number | null

    comparableTasks: number
    method: string
  }

  minTrialsPerTool: number
}

export const NONE = '(none)'
export const PHANTOM = '(phantom)'
export const MULTI_CALL = '(multiple calls)'

export const MIN_TRIALS_PER_TOOL = 5

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const k = key(item)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}

function isScored(trial: ScoredTrial): boolean {
  return trial.verdict !== 'error'
}

export function computeMetrics(
  trials: readonly ScoredTrial[],
  tasks: readonly Task[],
  tools: readonly NormalizedTool[],
  tokensByTool: Record<string, { total: number }> = {},
): RunMetrics {
  const scored = trials.filter(isScored)
  const errored = trials.length - scored.length

  const realTasks = scored.filter((trial) => trial.expected !== null)
  const distractors = scored.filter((trial) => trial.expected === null)

  const verdicts = countBy(scored, (trial) => trial.verdict)
  const verdict = (name: Verdict): number => verdicts.get(name) ?? 0

  const matrix: Record<string, Record<string, number>> = {}
  const bump = (expected: string, picked: string): void => {
    const row = (matrix[expected] ??= {})
    row[picked] = (row[picked] ?? 0) + 1
  }
  const onSurface = new Set(tools.map((tool) => tool.name))
  for (const trial of scored) {
    const expected = trial.expected ?? NONE
    const picked = trial.unexpectedAdditionalCalls
      ? MULTI_CALL
      : trial.pick === null
        ? trial.calls.length > 0 || trial.callCount > 0
          ? PHANTOM
          : NONE
        : onSurface.has(trial.pick)
          ? trial.pick
          : PHANTOM
    bump(expected, picked)
  }

  const expectedByTool = new Map<string, ScoredTrial[]>()
  for (const trial of realTasks) {
    const list = expectedByTool.get(trial.expected as string)
    if (list === undefined) expectedByTool.set(trial.expected as string, [trial])
    else list.push(trial)
  }

  const byTool: ToolMetrics[] = []
  for (const tool of tools) {
    const own = expectedByTool.get(tool.name) ?? []
    const correct = own.filter((trial) => trial.verdict === 'correct')
    const withArguments = correct.filter(
      (trial) => trial.argumentCheck !== undefined && !trial.argumentCheck.vacuous,
    )
    const argumentsValid = withArguments.filter((trial) => {
      const check = trial.argumentCheck as NonNullable<ScoredTrial['argumentCheck']>
      return (
        check.parsed &&
        check.missingRequired.length === 0 &&
        check.hallucinated.length === 0 &&
        check.wrongType.length === 0
      )
    })

    const confusedWith = [
      ...countBy(
        own.filter((trial) => trial.verdict === 'wrong-tool'),
        (trial) => trial.pick as string,
      ),
    ]
      .map(([name, count]) => ({ tool: name, count }))
      .sort((a, b) => b.count - a.count || (a.tool < b.tool ? -1 : 1))

    byTool.push({
      tool: tool.name,
      accuracy: proportion(correct.length, own.length),
      confusedWith,
      abstained: own.filter((trial) => trial.verdict === 'abstained').length,
      phantom: own.filter((trial) => trial.verdict === 'phantom').length,
      errors: trials.filter((trial) => trial.verdict === 'error' && trial.expected === tool.name)
        .length,
      argumentAccuracy: proportion(argumentsValid.length, withArguments.length),
      hallucinatedParameters: own.reduce(
        (sum, trial) => sum + (trial.argumentCheck?.hallucinated.length ?? 0),
        0,
      ),
      contextTokens: tokensByTool[tool.name]?.total ?? 0,
    })
  }
  byTool.sort((a, b) => {
    const aValue = a.accuracy.value ?? 2
    const bValue = b.accuracy.value ?? 2
    return aValue - bValue || (a.tool < b.tool ? -1 : 1)
  })

  const pairs = new Map<string, ConfusionPair>()
  for (const trial of realTasks) {
    if (trial.verdict !== 'wrong-tool') continue
    const expected = trial.expected as string
    const picked = trial.pick as string
    const [a, b] = expected < picked ? [expected, picked] : [picked, expected]
    // The separator is written as an escape, not a literal NUL byte: a raw one makes
    // git classify this file as binary, which drops it out of every diff and review.
    const key = `${a}\u0000${b}`
    const existing = pairs.get(key) ?? {
      tools: [a, b] as [string, string],
      swaps: 0,
      rate: proportion(0, 0),
      aChosenWhenBExpected: 0,
      bChosenWhenAExpected: 0,
    }
    existing.swaps += 1
    if (picked === a) existing.aChosenWhenBExpected += 1
    else existing.bChosenWhenAExpected += 1
    pairs.set(key, existing)
  }
  const confusionPairs = [...pairs.values()].map((pair) => {
    const denominator =
      (expectedByTool.get(pair.tools[0])?.length ?? 0) +
      (expectedByTool.get(pair.tools[1])?.length ?? 0)
    return { ...pair, rate: proportion(pair.swaps, denominator) }
  })
  confusionPairs.sort((a, b) => b.swaps - a.swaps || (a.tools[0] < b.tools[0] ? -1 : 1))

  // position sensitivity
  // Pooled buckets, kept for description only.
  const byPosition = new Map<number, { correct: number; total: number }>()
  for (const trial of realTasks) {
    if (trial.expectedPosition < 0) continue
    const bucket = byPosition.get(trial.expectedPosition) ?? { correct: 0, total: 0 }
    bucket.total += 1
    if (trial.verdict === 'correct') bucket.correct += 1
    byPosition.set(trial.expectedPosition, bucket)
  }
  const buckets: PositionBucket[] = [...byPosition]
    .sort((a, b) => a[0] - b[0])
    .map(([position, bucket]) => ({ position, accuracy: proportion(bucket.correct, bucket.total) }))

  // The effect itself, measured within each task so that task difficulty cannot leak in.
  const perTaskPositions = new Map<string, Map<number, { correct: number; total: number }>>()
  for (const trial of realTasks) {
    if (trial.expectedPosition < 0) continue
    const positions = perTaskPositions.get(trial.taskId) ?? new Map()
    const cell = positions.get(trial.expectedPosition) ?? { correct: 0, total: 0 }
    cell.total += 1
    if (trial.verdict === 'correct') cell.correct += 1
    positions.set(trial.expectedPosition, cell)
    perTaskPositions.set(trial.taskId, positions)
  }

  let spreadSum = 0
  let comparableTasks = 0
  for (const positions of perTaskPositions.values()) {
    if (positions.size < 2) continue
    const rates = [...positions.values()].map((cell) => cell.correct / cell.total)
    spreadSum += Math.max(...rates) - Math.min(...rates)
    comparableTasks += 1
  }
  const spread = comparableTasks === 0 ? null : spreadSum / comparableTasks

  return {
    trials: { planned: trials.length, scored: scored.length, errored },
    accuracy: proportion(verdict('correct'), realTasks.length),
    abstention: proportion(verdict('abstained'), realTasks.length),
    overTrigger: proportion(verdict('over-triggered'), distractors.length),
    phantom: proportion(verdict('phantom'), realTasks.length),
    multiCallRate: proportion(
      scored.filter((trial) => trial.unexpectedAdditionalCalls).length,
      scored.length,
    ),
    clarification: proportion(
      scored.filter((trial) => trial.askedForClarification).length,
      scored.length,
    ),
    byTool,
    confusionMatrix: matrix,
    confusionPairs,
    position: {
      buckets,
      spread,
      comparableTasks,
      method:
        'mean within-task gap between the best and worst position, over tasks tried at two ' +
        'or more positions; pooling positions across tasks would report task difficulty as ' +
        'a position effect',
    },
    minTrialsPerTool: MIN_TRIALS_PER_TOOL,
  }
}

/** Tools whose figures rest on too few trials to act on. */
export function thinlyMeasuredTools(metrics: RunMetrics): string[] {
  return metrics.byTool
    .filter(
      (tool) =>
        tool.accuracy.denominator > 0 && tool.accuracy.denominator < metrics.minTrialsPerTool,
    )
    .map((tool) => tool.tool)
}
