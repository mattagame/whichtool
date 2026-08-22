import { describe, expect, test } from 'bun:test'
import { computeMetrics, NONE, PHANTOM, proportion } from '../src/core/eval/metrics.js'
import type { TrialOutcome } from '../src/core/eval/runner.js'
import { scoreTrials } from '../src/core/eval/scorer.js'
import { normalizeTools } from '../src/core/surface/normalize.js'
import type { Task } from '../src/core/tasks/schema.js'
import type { RawTool } from '../src/core/types.js'

const RAW: RawTool[] = [
  {
    name: 'list_users',
    description: 'List users.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'search_users',
    description: 'Search users.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    },
  },
  { name: 'get_user', description: 'Get one user.', inputSchema: { type: 'object' } },
]
const TOOLS = normalizeTools(RAW).tools

const TASKS: Task[] = [
  { id: 't1', prompt: 'list them', expected: 'list_users', tags: [] },
  { id: 't2', prompt: 'find rossi', expected: 'search_users', tags: [] },
  { id: 't3', prompt: 'delete everything', expected: null, tags: ['distractor'] },
]

function outcome(
  partial: Partial<TrialOutcome> & Pick<TrialOutcome, 'taskId' | 'expected'>,
): TrialOutcome {
  const calls =
    partial.calls ??
    (partial.pick === undefined || partial.pick === null
      ? []
      : [
          {
            name: partial.pick,
            arguments: partial.arguments ?? null,
            ...(partial.rawArguments === undefined ? {} : { rawArguments: partial.rawArguments }),
          },
        ])
  return {
    trialIndex: 0,
    pick: null,
    arguments: null,
    text: '',
    order: ['list_users', 'search_users', 'get_user'],
    expectedPosition: 0,
    latencyMs: 1,
    ...partial,
    calls,
    callCount: calls.length,
  }
}

describe('proportion', () => {
  test('carries its denominator and a Wilson interval', () => {
    const p = proportion(3, 7)
    expect(p.numerator).toBe(3)
    expect(p.denominator).toBe(7)
    expect(p.value).toBeCloseTo(3 / 7, 10)
    expect(p.ci95?.[0]).toBeGreaterThan(0)
    expect(p.ci95?.[1]).toBeLessThan(1)
    expect(p.ci95?.[0]).toBeLessThan(p.value as number)
    expect(p.ci95?.[1]).toBeGreaterThan(p.value as number)
  })

  test('a rate over nothing is unknown, not zero', () => {
    const p = proportion(0, 0)
    expect(p.value).toBeNull()
    expect(p.ci95).toBeNull()
  })

  test('the interval narrows as n grows', () => {
    const small = proportion(5, 10)
    const large = proportion(500, 1000)
    const width = (p: ReturnType<typeof proportion>): number =>
      (p.ci95 as [number, number])[1] - (p.ci95 as [number, number])[0]
    expect(width(large)).toBeLessThan(width(small))
  })

  test('stays inside [0, 1] at the extremes', () => {
    for (const p of [proportion(0, 3), proportion(3, 3)]) {
      expect((p.ci95 as [number, number])[0]).toBeGreaterThanOrEqual(0)
      expect((p.ci95 as [number, number])[1]).toBeLessThanOrEqual(1)
    }
  })
})

describe('scoreTrials', () => {
  test('assigns each verdict', () => {
    const scored = scoreTrials(
      [
        outcome({ taskId: 't1', expected: 'list_users', pick: 'list_users' }),
        outcome({ taskId: 't1', expected: 'list_users', pick: 'search_users' }),
        outcome({ taskId: 't1', expected: 'list_users', pick: 'ghost_tool' }),
        outcome({ taskId: 't1', expected: 'list_users', pick: null }),
        outcome({ taskId: 't3', expected: null, pick: null }),
        outcome({ taskId: 't3', expected: null, pick: 'list_users' }),
        outcome({
          taskId: 't1',
          expected: 'list_users',
          error: { message: 'boom', retryable: true },
        }),
      ],
      TOOLS,
    )
    expect(scored.map((trial) => trial.verdict)).toEqual([
      'correct',
      'wrong-tool',
      'phantom',
      'abstained',
      'correct-abstention',
      'over-triggered',
      'error',
    ])
  })

  test('spots a request for clarification instead of a choice', () => {
    const scored = scoreTrials(
      [
        outcome({
          taskId: 't2',
          expected: 'search_users',
          pick: null,
          text: 'Which user do you mean?',
        }),
        outcome({ taskId: 't2', expected: 'search_users', pick: null, text: 'I cannot do that.' }),
      ],
      TOOLS,
    )
    expect(scored.map((trial) => trial.askedForClarification)).toEqual([true, false])
  })

  test('does not call a correct first pick fully correct when more calls follow', () => {
    const scored = scoreTrials(
      [
        outcome({
          taskId: 't1',
          expected: 'list_users',
          pick: 'list_users',
          arguments: { limit: 10 },
          calls: [
            { name: 'list_users', arguments: { limit: 10 } },
            { name: 'search_users', arguments: { query: 'everyone' } },
          ],
          callCount: 2,
        }),
      ],
      TOOLS,
    )

    expect(scored[0]).toMatchObject({
      verdict: 'unexpected-additional-calls',
      unexpectedAdditionalCalls: true,
      pick: 'list_users',
    })
  })

  test('does not treat a malformed nameless call as abstention', () => {
    const scored = scoreTrials(
      [
        outcome({
          taskId: 't1',
          expected: 'list_users',
          calls: [{ name: null, arguments: { limit: 10 } }],
          callCount: 1,
        }),
        outcome({
          taskId: 't3',
          expected: null,
          calls: [{ name: null, arguments: null }],
          callCount: 1,
        }),
      ],
      TOOLS,
    )

    expect(scored.map((trial) => trial.verdict)).toEqual(['phantom', 'over-triggered'])
    const metrics = computeMetrics(scored, TASKS, TOOLS)
    expect(metrics.confusionMatrix['list_users']?.[PHANTOM]).toBe(1)
    expect(metrics.confusionMatrix[NONE]?.[PHANTOM]).toBe(1)
  })
})

describe('multi-call metrics', () => {
  test('carry an explicit scored-trial denominator and reduce accuracy', () => {
    const trials = scoreTrials(
      [
        outcome({
          taskId: 't1',
          expected: 'list_users',
          pick: 'list_users',
          calls: [
            { name: 'list_users', arguments: null },
            { name: 'search_users', arguments: null },
          ],
          callCount: 2,
        }),
        outcome({ taskId: 't1', expected: 'list_users', pick: 'list_users' }),
        outcome({
          taskId: 't1',
          expected: 'list_users',
          error: { message: 'unavailable', retryable: true },
        }),
      ],
      TOOLS,
    )
    const metrics = computeMetrics(trials, TASKS, TOOLS)

    expect(metrics.multiCallRate).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 })
    expect(metrics.accuracy).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 })
  })
})

describe('argument checking', () => {
  const check = (args: Record<string, unknown> | null, raw?: string) =>
    scoreTrials(
      [
        outcome({
          taskId: 't2',
          expected: 'search_users',
          pick: 'search_users',
          arguments: args as never,
          ...(raw === undefined ? {} : { rawArguments: raw }),
        }),
      ],
      TOOLS,
    )[0]?.argumentCheck

  test('accepts valid arguments', () => {
    const result = check({ query: 'rossi', limit: 10 })
    expect(result).toMatchObject({
      missingRequired: [],
      hallucinated: [],
      wrongType: [],
      parsed: true,
    })
  })

  test('reports a missing required parameter', () => {
    expect(check({ limit: 10 })?.missingRequired).toEqual(['query'])
  })

  test('reports a parameter the schema never declared', () => {
    expect(check({ query: 'x', sortBy: 'name' })?.hallucinated).toEqual(['sortBy'])
  })

  test('reports a wrong type', () => {
    expect(check({ query: 42 })?.wrongType).toEqual([
      { name: 'query', expected: 'string', got: 'integer' },
    ])
  })

  test('accepts an integer where a number is declared', () => {
    expect(check({ query: 'x', limit: 3 })?.wrongType).toEqual([])
  })

  test('records that the arguments never parsed', () => {
    expect(check(null, '{not json')?.parsed).toBe(false)
  })

  test('calls a parameterless tool vacuous rather than scoring it', () => {
    const result = scoreTrials(
      [outcome({ taskId: 't1', expected: 'get_user', pick: 'get_user' })],
      TOOLS,
    )[0]?.argumentCheck
    expect(result?.vacuous).toBe(true)
  })
})

/**
 * The hand-built scenario SPEC §10 asks for: ten trials whose every metric can be worked
 * out on paper, so a change in the arithmetic is caught rather than rationalised.
 */
describe('computeMetrics over a hand-computable run', () => {
  const outcomes: TrialOutcome[] = [
    outcome({ taskId: 't1', expected: 'list_users', pick: 'list_users', expectedPosition: 0 }),
    outcome({ taskId: 't1', expected: 'list_users', pick: 'search_users', expectedPosition: 1 }),
    outcome({ taskId: 't1', expected: 'list_users', pick: 'list_users', expectedPosition: 0 }),
    outcome({ taskId: 't1', expected: 'list_users', pick: null, expectedPosition: 2 }),
    outcome({ taskId: 't2', expected: 'search_users', pick: 'search_users', expectedPosition: 0 }),
    outcome({ taskId: 't2', expected: 'search_users', pick: 'list_users', expectedPosition: 1 }),
    outcome({ taskId: 't2', expected: 'search_users', pick: 'ghost_tool', expectedPosition: 2 }),
    outcome({ taskId: 't3', expected: null, pick: null, expectedPosition: -1 }),
    outcome({ taskId: 't3', expected: null, pick: 'list_users', expectedPosition: -1 }),
    outcome({ taskId: 't1', expected: 'list_users', error: { message: 'boom', retryable: true } }),
  ]
  const metrics = computeMetrics(scoreTrials(outcomes, TOOLS), TASKS, TOOLS)

  test('separates errored trials from every rate', () => {
    expect(metrics.trials).toEqual({ planned: 10, scored: 9, errored: 1 })
  })

  test('accuracy is 3 correct over 7 non-distractor trials', () => {
    expect(metrics.accuracy.numerator).toBe(3)
    expect(metrics.accuracy.denominator).toBe(7)
  })

  test('abstention is 1 over the same 7', () => {
    expect(metrics.abstention.numerator).toBe(1)
    expect(metrics.abstention.denominator).toBe(7)
  })

  test('over-trigger is 1 over the 2 distractor trials, not over all trials', () => {
    expect(metrics.overTrigger.numerator).toBe(1)
    expect(metrics.overTrigger.denominator).toBe(2)
  })

  test('the phantom call is counted as phantom, not as a confusion', () => {
    expect(metrics.phantom.numerator).toBe(1)
    expect(metrics.phantom.denominator).toBe(7)
  })

  test("per-tool figures use only that tool's own trials", () => {
    const byName = new Map(metrics.byTool.map((tool) => [tool.tool, tool]))
    expect(byName.get('list_users')?.accuracy).toMatchObject({ numerator: 2, denominator: 4 })
    expect(byName.get('search_users')?.accuracy).toMatchObject({ numerator: 1, denominator: 3 })
    expect(byName.get('get_user')?.accuracy.denominator).toBe(0)
  })

  test('records what each tool was confused with', () => {
    const byName = new Map(metrics.byTool.map((tool) => [tool.tool, tool]))
    expect(byName.get('list_users')?.confusedWith).toEqual([{ tool: 'search_users', count: 1 }])
    expect(byName.get('search_users')?.confusedWith).toEqual([{ tool: 'list_users', count: 1 }])
  })

  test('the confusion matrix has a column for abstention and one for phantoms', () => {
    expect(metrics.confusionMatrix['list_users']).toEqual({
      list_users: 2,
      search_users: 1,
      [NONE]: 1,
    })
    expect(metrics.confusionMatrix['search_users']).toEqual({
      search_users: 1,
      list_users: 1,
      [PHANTOM]: 1,
    })
    expect(metrics.confusionMatrix[NONE]).toEqual({ [NONE]: 1, list_users: 1 })
  })

  test("the pair swaps in both directions and its rate spans both tools' trials", () => {
    expect(metrics.confusionPairs).toHaveLength(1)
    const pair = metrics.confusionPairs[0]!
    expect(pair.tools).toEqual(['list_users', 'search_users'])
    expect(pair.swaps).toBe(2)
    // 4 list_users trials + 3 search_users trials.
    expect(pair.rate).toMatchObject({ numerator: 2, denominator: 7 })
    expect(pair.aChosenWhenBExpected).toBe(1)
    expect(pair.bChosenWhenAExpected).toBe(1)
  })

  test('position accuracy is bucketed by where the expected tool sat', () => {
    const buckets = new Map(metrics.position.buckets.map((b) => [b.position, b.accuracy]))
    expect(buckets.get(0)).toMatchObject({ numerator: 3, denominator: 3 })
    expect(buckets.get(1)).toMatchObject({ numerator: 0, denominator: 2 })
    expect(buckets.get(2)).toMatchObject({ numerator: 0, denominator: 2 })
  })

  test('spread is measured within each task, so task difficulty cannot leak into it', () => {
    // t1 sat at positions 0 (2/2 correct), 1 (0/1) and 2 (0/1) -> gap 1.
    // t2 sat at positions 0 (1/1), 1 (0/1) and 2 (0/1)          -> gap 1.
    expect(metrics.position.comparableTasks).toBe(2)
    expect(metrics.position.spread).toBeCloseTo(1, 10)
  })

  test('a position-blind model scores zero spread even when its accuracy is uneven', () => {
    // Every trial of a task gets the same verdict regardless of position, which is exactly
    // what a keyword-matching model does. Pooling positions across tasks would report a
    // large effect here; measuring within-task correctly reports none.
    const blind = [
      outcome({ taskId: 't1', expected: 'list_users', pick: 'list_users', expectedPosition: 0 }),
      outcome({ taskId: 't1', expected: 'list_users', pick: 'list_users', expectedPosition: 2 }),
      outcome({ taskId: 't2', expected: 'search_users', pick: 'list_users', expectedPosition: 0 }),
      outcome({ taskId: 't2', expected: 'search_users', pick: 'list_users', expectedPosition: 1 }),
    ]
    const blindMetrics = computeMetrics(scoreTrials(blind, TOOLS), TASKS, TOOLS)
    expect(blindMetrics.position.comparableTasks).toBe(2)
    expect(blindMetrics.position.spread).toBe(0)
    // The pooled table still shows a difference, which is why it is labelled descriptive.
    const pooled = new Map(blindMetrics.position.buckets.map((b) => [b.position, b.accuracy.value]))
    expect(pooled.get(0)).toBe(0.5)
    expect(pooled.get(2)).toBe(1)
  })

  test('spread is null when no task was tried at more than one position', () => {
    const single = [
      outcome({ taskId: 't1', expected: 'list_users', pick: 'list_users', expectedPosition: 0 }),
      outcome({
        taskId: 't2',
        expected: 'search_users',
        pick: 'search_users',
        expectedPosition: 1,
      }),
    ]
    const singleMetrics = computeMetrics(scoreTrials(single, TOOLS), TASKS, TOOLS)
    expect(singleMetrics.position.spread).toBeNull()
    expect(singleMetrics.position.comparableTasks).toBe(0)
  })

  test('sorts tools worst-first so the fix list reads top to bottom', () => {
    expect(metrics.byTool.map((tool) => tool.tool)).toEqual([
      'search_users',
      'list_users',
      'get_user',
    ])
  })
})
