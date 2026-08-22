import { WhichtoolError } from '../errors.js'
import { isJsonObject } from '../json.js'
import type { JsonValue } from '../types.js'
import { TASK_SET_VERSION, type Task, type TaskSet } from './schema.js'
import { parseYamlSubset } from './yaml.js'

function fail(message: string, hint?: string): never {
  throw new WhichtoolError('tasks/invalid', message, hint)
}

function rejectUnknownKeys(
  value: Record<string, JsonValue>,
  allowed: readonly string[],
  where: string,
): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key))
  if (unknown.length > 0) {
    fail(
      `${where} contains unsupported ${unknown.length === 1 ? 'field' : 'fields'}: ${unknown
        .map((key) => `\`${key}\``)
        .join(', ')}.`,
      'Remove unknown fields rather than relying on this version to ignore them.',
    )
  }
}

function readTask(raw: JsonValue, index: number, source: string): Task {
  const where = `${source}: task ${index}`
  if (!isJsonObject(raw)) fail(`${where} is not a mapping.`)
  rejectUnknownKeys(raw, ['id', 'prompt', 'expected', 'tags', 'derivedFrom'], where)

  const id = raw['id']
  if (typeof id !== 'string' || id.trim() === '') {
    fail(`${where} has no usable \`id\`.`, 'Every task needs a stable id; runs are compared by it.')
  }

  const prompt = raw['prompt']
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    fail(`${where} (\`${id}\`) has no usable \`prompt\`.`)
  }

  if (!Object.prototype.hasOwnProperty.call(raw, 'expected')) {
    fail(
      `${where} (\`${id}\`) does not set \`expected\`.`,
      'Write `expected: <tool>` for a task that should call a tool, or `expected: null` for a distractor. Leaving it out is not the same as either.',
    )
  }
  const expected = raw['expected']
  if (expected !== null && (typeof expected !== 'string' || expected.trim() === '')) {
    fail(`${where} (\`${id}\`) has an \`expected\` that is neither a tool name nor null.`)
  }

  const rawTags = raw['tags']
  let tags: string[] = []
  if (rawTags !== undefined) {
    if (!Array.isArray(rawTags) || rawTags.some((tag) => typeof tag !== 'string')) {
      fail(`${where} (\`${id}\`) has \`tags\` that are not a list of strings.`)
    }
    tags = rawTags as string[]
  }

  const task: Task = { id, prompt, expected: expected as string | null, tags }

  const derived = raw['derivedFrom']
  if (derived !== undefined) {
    if (!isJsonObject(derived)) {
      fail(`${where} (\`${id}\`) has a \`derivedFrom\` that is not a mapping.`)
    }
    rejectUnknownKeys(derived, ['taskId', 'mutation'], `${where} (\`${id}\`) \`derivedFrom\``)
    const taskId = derived['taskId']
    const mutation = derived['mutation']
    if (typeof taskId !== 'string' || typeof mutation !== 'string') {
      fail(`${where} (\`${id}\`) has an incomplete \`derivedFrom\` mapping.`)
    }
    task.derivedFrom = { taskId, mutation }
  }
  return task
}

export function readTaskSet(data: JsonValue, source: string): TaskSet {
  if (!isJsonObject(data)) fail(`${source} does not contain a task-set mapping.`)
  rejectUnknownKeys(data, ['version', 'surface', 'tasks'], source)

  const version = data['version']
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    fail(
      `${source} has no integer \`version\`.`,
      `The current task-set version is ${TASK_SET_VERSION}.`,
    )
  }
  if (version > TASK_SET_VERSION) {
    fail(
      `${source} declares task-set version ${version}, but this whichtool understands up to ${TASK_SET_VERSION}.`,
      'Upgrade whichtool rather than editing the version down; a newer file may use fields this build would ignore.',
    )
  }
  if (version !== TASK_SET_VERSION) {
    fail(
      `${source} declares unsupported task-set version ${version}; this build reads version ${TASK_SET_VERSION}.`,
      'Regenerate the task set with this version of whichtool.',
    )
  }

  const rawSurface = data['surface']
  if (rawSurface !== undefined && rawSurface !== null && typeof rawSurface !== 'string') {
    fail(`${source} has a \`surface\` that is not a string.`)
  }

  const rawTasks = data['tasks']
  if (!Array.isArray(rawTasks)) fail(`${source} has no \`tasks\` list.`)

  return {
    version,
    surface: typeof rawSurface === 'string' ? rawSurface : null,
    tasks: rawTasks.map((task, index) => readTask(task, index, source)),
    source,
  }
}

export function parseTaskSet(text: string, source: string): TaskSet {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (cause) {
      fail(`${source} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    return readTaskSet(parsed as JsonValue, source)
  }
  return readTaskSet(parseYamlSubset(text), source)
}
