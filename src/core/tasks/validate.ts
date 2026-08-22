import type { Diagnostic, NormalizedTool, Surface } from '../types.js'
import { countDistractors, expectedTools, type Task, type TaskSet } from './schema.js'

export const MIN_TASKS_PER_TOOL = 3

export const MIN_DISTRACTOR_SHARE = 0.15

export interface TaskSetValidation {
  diagnostics: Diagnostic[]

  ok: boolean
  coverage: {
    taskCount: number
    distractorCount: number
    toolsOnSurface: number
    toolsCovered: number

    uncoveredTools: string[]
  }
}

function duplicateIds(tasks: readonly Task[]): Map<string, number[]> {
  const positions = new Map<string, number[]>()
  tasks.forEach((task, index) => {
    const existing = positions.get(task.id)
    if (existing === undefined) positions.set(task.id, [index])
    else existing.push(index)
  })
  return new Map([...positions].filter(([, list]) => list.length > 1))
}

export function validateTaskSet(set: TaskSet, surface: Surface | null): TaskSetValidation {
  const diagnostics: Diagnostic[] = []
  const toolNames = new Set((surface?.tools ?? []).map((tool: NormalizedTool) => tool.name))

  for (const [id, positions] of duplicateIds(set.tasks)) {
    diagnostics.push({
      code: 'tasks/duplicate-id',
      severity: 'error',
      message: `Task id \`${id}\` is used ${positions.length} times (positions ${positions.join(', ')}). Ids identify trials across runs, so they have to be unique.`,
      detail: { id, positions: positions as unknown as never },
    })
  }

  const seenPrompts = new Map<string, string>()
  for (const task of set.tasks) {
    const key = task.prompt.trim().toLowerCase()
    const previous = seenPrompts.get(key)
    if (previous !== undefined) {
      diagnostics.push({
        code: 'tasks/duplicate-prompt',
        severity: 'warning',
        message: `\`${task.id}\` and \`${previous}\` have the same prompt, so they measure the same thing twice and inflate the denominator.`,
        detail: { id: task.id, other: previous },
      })
    } else {
      seenPrompts.set(key, task.id)
    }
  }

  if (surface !== null) {
    for (const task of set.tasks) {
      if (task.expected === null || toolNames.has(task.expected)) continue
      diagnostics.push({
        code: 'tasks/expected-not-on-surface',
        severity: 'error',
        message: `\`${task.id}\` expects \`${task.expected}\`, which this surface does not expose. The task can never pass.`,
        detail: { id: task.id, expected: task.expected },
      })
    }

    if (set.surface !== null && set.surface !== surface.hash) {
      diagnostics.push({
        code: 'tasks/surface-changed',
        severity: 'warning',
        message: `The task set was written against surface ${set.surface.slice(0, 19)}, but this surface is ${surface.hash.slice(0, 19)}. The tasks may no longer describe what the server exposes.`,
        detail: { taskSetSurface: set.surface, currentSurface: surface.hash },
      })
    }
  }

  const covered = new Set(expectedTools(set.tasks))
  const uncovered = [...toolNames].filter((name) => !covered.has(name)).sort()
  if (surface !== null && uncovered.length > 0) {
    diagnostics.push({
      code: 'tasks/uncovered-tools',
      severity: 'warning',
      message: `${uncovered.length} of ${toolNames.size} tools have no task that expects them, so the run says nothing about whether the model can find them: ${uncovered.join(', ')}.`,
      tools: uncovered,
    })
  }

  const perTool = new Map<string, number>()
  for (const task of set.tasks) {
    if (task.expected === null) continue
    perTool.set(task.expected, (perTool.get(task.expected) ?? 0) + 1)
  }
  const thin = [...perTool].filter(([, count]) => count < MIN_TASKS_PER_TOOL).map(([name]) => name)
  if (thin.length > 0) {
    diagnostics.push({
      code: 'tasks/thin-coverage',
      severity: 'info',
      message: `${thin.length} tools have fewer than ${MIN_TASKS_PER_TOOL} tasks, so their accuracy will carry a confidence interval too wide to act on: ${thin.sort().join(', ')}.`,
      tools: thin.sort(),
    })
  }

  const distractors = countDistractors(set.tasks)
  if (set.tasks.length > 0) {
    if (distractors === 0) {
      diagnostics.push({
        code: 'tasks/no-distractors',
        severity: 'warning',
        message:
          'The set has no distractors, so the run cannot measure over-triggering at all. A tool set optimised only against abstention gets worse at refusing, and nothing here would show it.',
      })
    } else if (distractors / set.tasks.length < MIN_DISTRACTOR_SHARE) {
      diagnostics.push({
        code: 'tasks/few-distractors',
        severity: 'info',
        message: `${distractors} of ${set.tasks.length} tasks are distractors (${Math.round((distractors / set.tasks.length) * 100)}%). The over-trigger rate will be computed over a small denominator and reported with a wide interval.`,
        detail: { distractors, total: set.tasks.length },
      })
    }
  }

  if (set.tasks.length === 0) {
    diagnostics.push({
      code: 'tasks/empty',
      severity: 'error',
      message: 'The task set contains no tasks.',
    })
  }

  return {
    diagnostics,
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    coverage: {
      taskCount: set.tasks.length,
      distractorCount: distractors,
      toolsOnSurface: toolNames.size,
      toolsCovered: [...covered].filter((name) => toolNames.size === 0 || toolNames.has(name))
        .length,
      uncoveredTools: uncovered,
    },
  }
}
