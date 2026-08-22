import type { JsonObject } from '../types.js'

export const TASK_SET_VERSION = 1

export interface Task {
  id: string

  prompt: string

  expected: string | null
  tags: string[]

  derivedFrom?: { taskId: string; mutation: string }
}

export interface TaskSet {
  version: number

  surface: string | null
  tasks: Task[]

  source: string
}

export function countDistractors(tasks: readonly Task[]): number {
  return tasks.filter((task) => task.expected === null).length
}

export function expectedTools(tasks: readonly Task[]): string[] {
  const names = new Set<string>()
  for (const task of tasks) {
    if (task.expected !== null) names.add(task.expected)
  }
  return [...names].sort()
}

export function tasksMatchingTags(
  tasks: readonly Task[],
  only: readonly string[],
  skip: readonly string[],
): Task[] {
  return tasks.filter((task) => {
    if (skip.length > 0 && task.tags.some((tag) => skip.includes(tag))) return false
    if (only.length > 0 && !task.tags.some((tag) => only.includes(tag))) return false
    return true
  })
}

export function taskSetToYaml(set: Pick<TaskSet, 'version' | 'surface' | 'tasks'>): string {
  const quote = (text: string): string => JSON.stringify(text)
  const lines: string[] = ['# whichtool.tasks.yaml', `version: ${set.version}`]
  lines.push(
    set.surface === null
      ? 'surface: null'
      : `surface: ${quote(set.surface)}   # the surface it was written against; a change is reported, not fatal`,
  )
  lines.push('tasks:')

  for (const task of set.tasks) {
    lines.push(`  - id: ${quote(task.id)}`)
    lines.push(`    prompt: ${quote(task.prompt)}`)
    lines.push(
      task.expected === null
        ? '    expected: null          # a distractor: no tool should be called'
        : `    expected: ${quote(task.expected)}`,
    )
    lines.push(`    tags: [${task.tags.map(quote).join(', ')}]`)
    if (task.derivedFrom !== undefined) {
      // A block mapping, not a flow one: the subset reader refuses `{ … }`, and a file
      // whichtool wrote that whichtool cannot read back is not a task set.
      lines.push('    derivedFrom:')
      lines.push(`      taskId: ${quote(task.derivedFrom.taskId)}`)
      lines.push(`      mutation: ${quote(task.derivedFrom.mutation)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** The JSON shape, for consumers that would rather not depend on the YAML subset. */
export function taskSetToJson(set: Pick<TaskSet, 'version' | 'surface' | 'tasks'>): JsonObject {
  return {
    version: set.version,
    surface: set.surface,
    tasks: set.tasks.map((task) => ({
      id: task.id,
      prompt: task.prompt,
      expected: task.expected,
      tags: [...task.tags],
      ...(task.derivedFrom === undefined
        ? {}
        : {
            derivedFrom: { taskId: task.derivedFrom.taskId, mutation: task.derivedFrom.mutation },
          }),
    })),
  }
}
