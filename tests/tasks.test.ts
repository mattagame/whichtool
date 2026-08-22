import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTaskSet } from '../src/core/tasks/load.js'
import { countDistractors, tasksMatchingTags, taskSetToYaml } from '../src/core/tasks/schema.js'
import { validateTaskSet } from '../src/core/tasks/validate.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import { snapshotTransportFromData } from '../src/core/transport/index.js'
import { readFixture, REPO_ROOT } from './helpers.js'
import type { Surface } from '../src/core/types.js'

const TASKS_FILE = join(REPO_ROOT, 'tests', 'fixtures', 'tasks', 'list-search.tasks.yaml')

async function surfaceOf(fixture: string): Promise<Surface> {
  return loadSurface(snapshotTransportFromData(readFixture(fixture), fixture))
}

describe('loading a task set', () => {
  const set = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), TASKS_FILE)

  test('reads the committed fixture', () => {
    expect(set.version).toBe(1)
    expect(set.tasks).toHaveLength(10)
    expect(countDistractors(set.tasks)).toBe(3)
  })

  test('keeps `expected: null` distinct from a tool name', () => {
    expect(set.tasks.find((task) => task.id === 'distractor.delete')?.expected).toBeNull()
    expect(set.tasks.find((task) => task.id === 'users.list.basic')?.expected).toBe('list_users')
  })

  test('reads tags from a flow sequence', () => {
    expect(set.tasks[0]?.tags).toEqual(['users', 'read'])
  })

  test('accepts JSON as readily as YAML', () => {
    const json = parseTaskSet(
      JSON.stringify({
        version: 1,
        tasks: [{ id: 'a', prompt: 'p', expected: null, tags: [] }],
      }),
      'inline.json',
    )
    expect(json.tasks[0]?.expected).toBeNull()
  })

  test('refuses a task that omits `expected` instead of treating it as a distractor', () => {
    // Silently becoming a distractor would corrupt the over-trigger rate, which is the
    // one metric distractors exist to produce.
    expect(() =>
      parseTaskSet(
        JSON.stringify({ version: 1, tasks: [{ id: 'a', prompt: 'p' }] }),
        'inline.json',
      ),
    ).toThrow(/does not set `expected`/)
  })

  test('refuses a task with no id or no prompt', () => {
    expect(() =>
      parseTaskSet(JSON.stringify({ version: 1, tasks: [{ prompt: 'p', expected: null }] }), 'x'),
    ).toThrow(/no usable `id`/)
    expect(() =>
      parseTaskSet(JSON.stringify({ version: 1, tasks: [{ id: 'a', expected: null }] }), 'x'),
    ).toThrow(/no usable `prompt`/)
  })

  test('refuses a future task-set version rather than misreading it', () => {
    expect(() => parseTaskSet(JSON.stringify({ version: 99, tasks: [] }), 'x')).toThrow(
      /understands up to 1/,
    )
  })

  test('refuses legacy versions and unknown fields instead of silently changing meaning', () => {
    expect(() => parseTaskSet(JSON.stringify({ version: 0, tasks: [] }), 'x')).toThrow(
      /unsupported task-set version 0/,
    )
    expect(() =>
      parseTaskSet(
        JSON.stringify({
          version: 1,
          typo: true,
          tasks: [{ id: 'a', prompt: 'p', expected: null }],
        }),
        'x',
      ),
    ).toThrow(/unsupported field: `typo`/)
    expect(() =>
      parseTaskSet(
        JSON.stringify({
          version: 1,
          tasks: [{ id: 'a', prompt: 'p', expected: null, expectd: 'wrong' }],
        }),
        'x',
      ),
    ).toThrow(/unsupported field: `expectd`/)
  })

  test('refuses malformed derivation metadata instead of discarding it', () => {
    expect(() =>
      parseTaskSet(
        JSON.stringify({
          version: 1,
          tasks: [{ id: 'a', prompt: 'p', expected: null, derivedFrom: { taskId: 'source' } }],
        }),
        'x',
      ),
    ).toThrow(/incomplete `derivedFrom`/)
  })

  test('refuses null tags rather than accepting data outside the published schema', () => {
    expect(() =>
      parseTaskSet(
        JSON.stringify({
          version: 1,
          tasks: [{ id: 'a', prompt: 'p', expected: null, tags: null }],
        }),
        'x',
      ),
    ).toThrow(/`tags` that are not a list/)
  })

  test('round-trips through the YAML writer', () => {
    const rewritten = parseTaskSet(taskSetToYaml(set), 'rewritten.yaml')
    expect(rewritten.tasks).toEqual(set.tasks)
  })
})

describe('tag filtering', () => {
  const set = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), TASKS_FILE)

  test('--only keeps just the matching tag', () => {
    expect(tasksMatchingTags(set.tasks, ['distractor'], [])).toHaveLength(3)
  })

  test('--skip removes the matching tag', () => {
    expect(tasksMatchingTags(set.tasks, [], ['distractor'])).toHaveLength(7)
  })

  test('no filters keeps everything', () => {
    expect(tasksMatchingTags(set.tasks, [], [])).toHaveLength(10)
  })
})

describe('validating a task set', () => {
  test('the committed fixture is clean against its surface', async () => {
    const set = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), TASKS_FILE)
    const validation = validateTaskSet(set, await surfaceOf('list-search-pair.json'))
    expect(validation.ok).toBe(true)
    expect(validation.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(validation.coverage).toMatchObject({
      taskCount: 10,
      distractorCount: 3,
      toolsOnSurface: 4,
      uncoveredTools: [],
    })
  })

  test('a duplicate id is an error, because ids identify trials across runs', async () => {
    const set = parseTaskSet(
      JSON.stringify({
        version: 1,
        tasks: [
          { id: 'a', prompt: 'one', expected: null },
          { id: 'a', prompt: 'two', expected: null },
        ],
      }),
      'x',
    )
    const validation = validateTaskSet(set, null)
    expect(validation.ok).toBe(false)
    expect(validation.diagnostics.map((d) => d.code)).toContain('tasks/duplicate-id')
  })

  test('an expected tool that is not on the surface can never pass, so it is an error', async () => {
    const set = parseTaskSet(
      JSON.stringify({ version: 1, tasks: [{ id: 'a', prompt: 'p', expected: 'no_such_tool' }] }),
      'x',
    )
    const validation = validateTaskSet(set, await surfaceOf('list-search-pair.json'))
    expect(validation.ok).toBe(false)
    expect(validation.diagnostics.map((d) => d.code)).toContain('tasks/expected-not-on-surface')
  })

  test('no distractors is a warning about what cannot be measured', async () => {
    const set = parseTaskSet(
      JSON.stringify({ version: 1, tasks: [{ id: 'a', prompt: 'p', expected: 'list_users' }] }),
      'x',
    )
    const codes = validateTaskSet(set, await surfaceOf('list-search-pair.json')).diagnostics.map(
      (d) => d.code,
    )
    expect(codes).toContain('tasks/no-distractors')
    expect(codes).toContain('tasks/uncovered-tools')
  })

  test('a changed surface hash is reported without blocking the run', async () => {
    const set = parseTaskSet(
      JSON.stringify({
        version: 1,
        surface: 'sha256:0000',
        tasks: [{ id: 'a', prompt: 'p', expected: 'list_users' }],
      }),
      'x',
    )
    const validation = validateTaskSet(set, await surfaceOf('list-search-pair.json'))
    const finding = validation.diagnostics.find((d) => d.code === 'tasks/surface-changed')
    expect(finding?.severity).toBe('warning')
    expect(validation.ok).toBe(true)
  })

  test('without a surface, the checks that need one are simply not run', () => {
    const set = parseTaskSet(
      JSON.stringify({ version: 1, tasks: [{ id: 'a', prompt: 'p', expected: 'anything' }] }),
      'x',
    )
    const validation = validateTaskSet(set, null)
    expect(validation.diagnostics.map((d) => d.code)).not.toContain('tasks/expected-not-on-surface')
  })

  test('an identical prompt twice is flagged as an inflated denominator', () => {
    const set = parseTaskSet(
      JSON.stringify({
        version: 1,
        tasks: [
          { id: 'a', prompt: 'same words', expected: null },
          { id: 'b', prompt: 'Same Words', expected: null },
        ],
      }),
      'x',
    )
    expect(validateTaskSet(set, null).diagnostics.map((d) => d.code)).toContain(
      'tasks/duplicate-prompt',
    )
  })

  test('an empty task set is an error', () => {
    const set = parseTaskSet(JSON.stringify({ version: 1, tasks: [] }), 'x')
    expect(validateTaskSet(set, null).ok).toBe(false)
  })
})
