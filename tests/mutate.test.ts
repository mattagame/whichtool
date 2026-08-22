import { describe, expect, test } from 'bun:test'
import { createRandom } from '../src/core/eval/planner.js'
import {
  casual,
  imperative,
  interrogative,
  mutateTasks,
  MUTATION_NAMES,
  polite,
  typo,
} from '../src/core/tasks/mutate.js'
import { parseTaskSet } from '../src/core/tasks/load.js'
import { taskSetToYaml } from '../src/core/tasks/schema.js'
import type { Task } from '../src/core/tasks/schema.js'

const TASKS: Task[] = [
  {
    id: 'list',
    prompt: 'Show me all the users in the workspace',
    expected: 'list_users',
    tags: ['read'],
  },
  {
    id: 'count',
    prompt: 'How many users does this workspace have?',
    expected: 'count_users',
    tags: ['read'],
  },
  {
    id: 'distract',
    prompt: 'Permanently delete the account belonging to Rossi',
    expected: null,
    tags: ['distractor'],
  },
]

describe('individual mutations', () => {
  test("typo changes the text without touching a word's first letter", () => {
    const mutated = typo('Show me all the users in the workspace', createRandom(1))
    expect(mutated).not.toBeNull()
    expect(mutated).not.toBe('Show me all the users in the workspace')
    for (const word of (mutated as string).split(' ')) {
      expect(word.length).toBeGreaterThan(0)
    }
  })

  test('typo is deterministic for a given seed', () => {
    const a = typo('Find the user whose name contains rossi', createRandom(7))
    const b = typo('Find the user whose name contains rossi', createRandom(7))
    expect(a).toBe(b)
  })

  test('typo declines a prompt with too little to work with', () => {
    expect(typo('a b', createRandom(1))).toBeNull()
  })

  test('casual strips politeness, capitals and closing punctuation', () => {
    expect(casual('Could you show me all the users?', createRandom(1))).toBe(
      'show me all the users',
    )
  })

  test('casual declines a prompt that is already casual', () => {
    expect(casual('show me the users', createRandom(1))).toBeNull()
  })

  test('polite wraps a bare command without doubling its verb', () => {
    const mutated = polite('Show me all the users', createRandom(3)) as string
    expect(mutated.startsWith('Could you please show me all the users')).toBe(true)
    // "Would you mind helping me show me ..." is the failure this guards against: a variant
    // nobody would type measures nothing.
    expect(mutated).not.toMatch(/\b(\w+ \w+) \1\b/)
  })

  test('polite declines a prompt that already asks politely, or already asks', () => {
    expect(polite('Could you show me the users?', createRandom(1))).toBeNull()
    expect(polite('How many users are there?', createRandom(1))).toBeNull()
  })

  test('every polite closer produces well-formed text', () => {
    const produced = new Set<string>()
    for (let seed = 0; seed < 30; seed += 1) {
      const mutated = polite('Show me all the users', createRandom(seed)) as string
      produced.add(mutated)
      expect(mutated).toMatch(/[.?]$/)
    }
    expect(produced.size).toBeGreaterThan(1)
  })

  test('imperative converts the patterns it recognises', () => {
    expect(imperative('Can you show me all the users?', createRandom(1))).toBe(
      'Show me all the users.',
    )
    expect(imperative('How many users are there?', createRandom(1))).toBe(
      'Tell me how many users are there.',
    )
  })

  test('imperative declines rather than mangling what it cannot convert', () => {
    // Half-converting a question would measure the mutation instead of the surface.
    expect(imperative('Rossi, is he still active?', createRandom(1))).toBeNull()
    expect(imperative('Show me the users', createRandom(1))).toBeNull()
  })

  test('interrogative converts a command and declines a question', () => {
    expect(interrogative('Show me all the users', createRandom(1))).toBe(
      'Could you show me all the users?',
    )
    expect(interrogative('How many users are there?', createRandom(1))).toBeNull()
  })
})

describe('mutateTasks', () => {
  test('keeps the originals and adds variants that carry their expected tool', () => {
    const result = mutateTasks(TASKS, { seed: 0 })
    expect(result.tasks.length).toBeGreaterThan(TASKS.length)

    for (const task of result.tasks) {
      if (task.derivedFrom === undefined) continue
      const original = TASKS.find((item) => item.id === task.derivedFrom?.taskId)
      // A variant the model gets wrong is a robustness failure, which only holds if the
      // expected answer did not change with the wording.
      expect(task.expected).toBe(original?.expected ?? null)
      expect(task.tags).toContain('mutated')
    }
  })

  test('is fully deterministic for a given seed', () => {
    const a = mutateTasks(TASKS, { seed: 5 })
    const b = mutateTasks(TASKS, { seed: 5 })
    expect(JSON.stringify(a.tasks)).toBe(JSON.stringify(b.tasks))
  })

  test('a different seed gives different typos', () => {
    const a = mutateTasks(TASKS, { seed: 1, mutations: ['typo'] })
    const b = mutateTasks(TASKS, { seed: 2, mutations: ['typo'] })
    expect(JSON.stringify(a.tasks)).not.toBe(JSON.stringify(b.tasks))
  })

  test('ids record where each variant came from', () => {
    const result = mutateTasks(TASKS, { seed: 0, mutations: ['casual'] })
    const derived = result.tasks.filter((task) => task.derivedFrom !== undefined)
    expect(derived.map((task) => task.id)).toEqual(
      derived.map((task) => `${task.derivedFrom?.taskId}.casual`),
    )
  })

  test('never mutates a mutation', () => {
    const once = mutateTasks(TASKS, { seed: 0 })
    const twice = mutateTasks(once.tasks, { seed: 0 })
    // The second pass sees the variants and leaves them alone, so nothing compounds.
    const newlyDerived = twice.tasks.filter(
      (task) => task.derivedFrom !== undefined && !once.tasks.some((item) => item.id === task.id),
    )
    expect(newlyDerived).toEqual([])
  })

  test('--no-originals drops them', () => {
    const result = mutateTasks(TASKS, { seed: 0, keepOriginals: false })
    expect(result.tasks.every((task) => task.derivedFrom !== undefined)).toBe(true)
  })

  test('reports what each mutation produced and what it declined', () => {
    const result = mutateTasks(TASKS, { seed: 0 })
    for (const name of MUTATION_NAMES) {
      expect(result.applied[name]).toBeDefined()
      const stats = result.applied[name] as { produced: number; skipped: number }
      expect(stats.produced + stats.skipped).toBe(TASKS.length)
    }
  })

  test('a mutation that never applied says so rather than passing silently', () => {
    const alreadyCasual: Task[] = [
      { id: 'a', prompt: 'show me the users', expected: 'list_users', tags: [] },
    ]
    const result = mutateTasks(alreadyCasual, { seed: 0, mutations: ['casual'] })
    expect(result.diagnostics.map((d) => d.code)).toContain('mutate/never-applied')
  })

  test('does not produce a variant identical to an existing prompt', () => {
    const result = mutateTasks(TASKS, { seed: 0 })
    const prompts = result.tasks.map((task) => task.prompt.trim())
    expect(new Set(prompts).size).toBe(prompts.length)
  })

  test('casual survives the duplicate check, since case is the point of it', () => {
    // Folding case in the duplicate check would silently discard every `casual` variant.
    const result = mutateTasks(TASKS, { seed: 0, mutations: ['casual'] })
    const stats = result.applied['casual'] as { produced: number; skipped: number }
    expect(stats.produced).toBe(TASKS.length)
    expect(
      result.tasks.some((task) => task.prompt === 'show me all the users in the workspace'),
    ).toBe(true)
  })

  test('rejects an unknown mutation by name', () => {
    expect(() => mutateTasks(TASKS, { mutations: ['nonsense'] })).toThrow(/unknown mutation/)
  })
})

describe('the file mutate writes is a file whichtool can read', () => {
  // A `mutate` output that the subset reader refuses breaks the documented
  // mutate -> lint -> run loop, and breaks it only at the second step, where the
  // failure looks like a bad task set rather than a bad writer.
  test('round-trips through taskSetToYaml and the subset parser', () => {
    const mutated = mutateTasks(TASKS, { seed: 0 })
    const yaml = taskSetToYaml({ version: 1, surface: null, tasks: mutated.tasks })
    const reparsed = parseTaskSet(yaml, 'round-trip.yaml')

    expect(reparsed.tasks.length).toBe(mutated.tasks.length)
    expect(reparsed.tasks.map((task) => task.id)).toEqual(mutated.tasks.map((task) => task.id))

    const derived = reparsed.tasks.filter((task) => task.derivedFrom !== undefined)
    expect(derived.length).toBeGreaterThan(0)
    expect(derived.map((task) => task.derivedFrom)).toEqual(
      mutated.tasks
        .filter((task) => task.derivedFrom !== undefined)
        .map((task) => task.derivedFrom),
    )
  })

  test('emits no flow mapping, which the subset reader refuses by design', () => {
    const mutated = mutateTasks(TASKS, { seed: 0 })
    const yaml = taskSetToYaml({ version: 1, surface: null, tasks: mutated.tasks })
    expect(yaml).not.toMatch(/^\s*\w+:\s*\{/m)
  })
})
