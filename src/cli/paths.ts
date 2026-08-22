import { isAbsolute, relative, resolve, sep } from 'node:path'
import { WhichtoolError } from '../core/errors.js'
import type { Runtime } from '../runtime/types.js'

export const DEFAULT_TASK_FILES = [
  'whichtool.tasks.yaml',
  'whichtool.tasks.yml',
  'whichtool.tasks.json',
] as const

export async function resolveTaskFile(
  runtime: Runtime,
  explicit: string | undefined,
  configured: string | undefined,
): Promise<string> {
  const candidate = explicit ?? configured
  if (candidate !== undefined) {
    const absolute = runtime.resolve(candidate)
    if (!(await runtime.fileExists(absolute))) {
      throw new WhichtoolError('tasks/not-found', `No task set at ${candidate}.`)
    }
    return absolute
  }
  for (const name of DEFAULT_TASK_FILES) {
    const absolute = runtime.resolve(name)
    if (await runtime.fileExists(absolute)) return absolute
  }
  throw new WhichtoolError(
    'tasks/not-found',
    'No task set given and none found in the working directory.',
    `Pass --tasks, set \`tasks\` in the config, or create one of: ${DEFAULT_TASK_FILES.join(', ')}.`,
  )
}

const HOME_PREFIX = /([A-Za-z]:[\\/]Users[\\/]|\/home\/|\/Users\/)[^\\/\s"']+[\\/]/g

export function redactMachinePaths(text: string, cwd: string): string {
  const normalisedCwd = cwd.replace(/[\\/]+$/, '')
  const escaped = normalisedCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text
    .replace(new RegExp(`${escaped}[\\\\/]?`, 'gi'), './')
    .replace(HOME_PREFIX, '~/')
    .replace(/\.\/\.\//g, './')
}

export function toDisplayPath(runtime: Runtime, path: string): string {
  if (!isAbsolute(path)) return path.split('\\').join('/')

  const cwd = runtime.cwd()
  const relativePath = relative(cwd, resolve(cwd, path))

  if (relativePath === '') return '.'
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    const parts = path.split(/[\\/]/)
    return parts[parts.length - 1] ?? path
  }
  return relativePath.split(sep).join('/')
}
