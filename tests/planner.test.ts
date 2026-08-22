import { describe, expect, test } from 'bun:test'
import {
  createRandom,
  hashString,
  orderTools,
  permute,
  planTrials,
} from '../src/core/eval/planner.js'
import { normalizeTools } from '../src/core/surface/normalize.js'
import type { Task } from '../src/core/tasks/schema.js'
import type { RawTool } from '../src/core/types.js'

const RAW: RawTool[] = ['alpha', 'bravo', 'charlie', 'delta'].map((name, index) => ({
  name,
  description: `Tool ${name}.`,
  inputSchema: { type: 'object' },
  // Served in reverse, so "served order" and "sorted by name" are distinguishable.
  _order: index,
}))
const TOOLS = normalizeTools([...RAW].reverse()).tools

const TASKS: Task[] = [
  { id: 't1', prompt: 'one', expected: 'alpha', tags: [] },
  { id: 't2', prompt: 'two', expected: null, tags: [] },
]

describe('the seeded primitives', () => {
  test('hashString is stable and differs on different input', () => {
    expect(hashString('abc')).toBe(hashString('abc'))
    expect(hashString('abc')).not.toBe(hashString('abd'))
  })

  test('createRandom is deterministic and stays in [0, 1)', () => {
    const a = createRandom(42)
    const b = createRandom(42)
    for (let index = 0; index < 50; index += 1) {
      const value = a()
      expect(value).toBe(b())
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  test('permute keeps every element exactly once', () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    const shuffled = permute(items, createRandom(7))
    expect([...shuffled].sort()).toEqual([...items].sort())
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('planTrials', () => {
  test('rejects an empty plan and invalid repeat values instead of silently planning zero trials', () => {
    expect(() => planTrials([], TOOLS)).toThrow('empty task set')
    expect(() => planTrials(TASKS, TOOLS, { repeat: 0 })).toThrow('between 1 and 1000')
    expect(() => planTrials(TASKS, TOOLS, { repeat: Number.NaN })).toThrow('between 1 and 1000')
    expect(() => planTrials(TASKS, TOOLS, { repeat: 1.5 })).toThrow('between 1 and 1000')
  })

  test('produces repeat trials per task', () => {
    const plan = planTrials(TASKS, TOOLS, { repeat: 3 })
    expect(plan.trials).toHaveLength(6)
    expect(plan.trials.filter((trial) => trial.taskId === 't1')).toHaveLength(3)
  })

  test('is reproducible: identical inputs give identical orders', () => {
    const a = planTrials(TASKS, TOOLS, { repeat: 5, seed: 11 })
    const b = planTrials(TASKS, TOOLS, { repeat: 5, seed: 11 })
    expect(JSON.stringify(a.trials)).toBe(JSON.stringify(b.trials))
  })

  test('a different seed gives different orders', () => {
    const a = planTrials(TASKS, TOOLS, { repeat: 5, seed: 1 })
    const b = planTrials(TASKS, TOOLS, { repeat: 5, seed: 2 })
    expect(JSON.stringify(a.trials.map((t) => t.order))).not.toBe(
      JSON.stringify(b.trials.map((t) => t.order)),
    )
  })

  test('every trial of a task gets a distinct order while distinct orders remain', () => {
    // 4 tools give 24 permutations, so 5 trials must never repeat one.
    const plan = planTrials(TASKS, TOOLS, { repeat: 5, seed: 3 })
    const forT1 = plan.trials
      .filter((trial) => trial.taskId === 't1')
      .map((trial) => trial.order.join(' '))
    expect(new Set(forT1).size).toBe(5)
  })

  test('each order is a permutation of the whole surface', () => {
    const plan = planTrials(TASKS, TOOLS, { repeat: 4, seed: 9 })
    const names = TOOLS.map((tool) => tool.name).sort()
    for (const trial of plan.trials) {
      expect([...trial.order].sort()).toEqual(names)
    }
  })

  test('--no-permute uses the order the server served, not alphabetical order', () => {
    const plan = planTrials(TASKS, TOOLS, { repeat: 2, permute: false })
    const served = [...TOOLS].sort((a, b) => a.originalIndex - b.originalIndex).map((t) => t.name)
    expect(served).toEqual(['delta', 'charlie', 'bravo', 'alpha'])
    for (const trial of plan.trials) expect(trial.order).toEqual(served)
    expect(plan.permuted).toBe(false)
  })

  test('expectedPosition points at the expected tool, and is -1 for a distractor', () => {
    const plan = planTrials(TASKS, TOOLS, { repeat: 4, seed: 5 })
    for (const trial of plan.trials) {
      if (trial.taskId === 't2') {
        expect(trial.expectedPosition).toBe(-1)
        continue
      }
      expect(trial.order[trial.expectedPosition]).toBe('alpha')
    }
  })

  test('positions actually vary, which is the entire point of permuting', () => {
    const plan = planTrials(TASKS, TOOLS, { repeat: 5, seed: 3 })
    const positions = plan.trials
      .filter((trial) => trial.taskId === 't1')
      .map((trial) => trial.expectedPosition)
    expect(new Set(positions).size).toBeGreaterThan(1)
  })

  test('a single-tool surface is left alone rather than pointlessly shuffled', () => {
    const single = normalizeTools([{ name: 'only', description: 'd', inputSchema: {} }]).tools
    const plan = planTrials(TASKS, single, { repeat: 3 })
    for (const trial of plan.trials) expect(trial.order).toEqual(['only'])
  })
})

describe('orderTools', () => {
  test('returns the tools in the requested order', () => {
    const ordered = orderTools(TOOLS, ['charlie', 'alpha'])
    expect(ordered.map((tool) => tool.name)).toEqual(['charlie', 'alpha'])
  })

  test('skips a name that is not on the surface', () => {
    expect(orderTools(TOOLS, ['alpha', 'ghost']).map((tool) => tool.name)).toEqual(['alpha'])
  })
})
