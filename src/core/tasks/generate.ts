import { WhichtoolError } from '../errors.js'
import { isJsonObject } from '../json.js'
import type { GenerateRequest, Provider } from '../providers/types.js'
import type { Diagnostic, JsonValue, NormalizedTool, Surface } from '../types.js'
import { TASK_SET_VERSION, type Task, type TaskSet } from './schema.js'

export interface GenerateOptions {
  tasksPerTool?: number
  distractors?: number
  temperature?: number

  prompt?: string
  signal?: AbortSignal | undefined
}

export const DEFAULT_TASKS_PER_TOOL = 3
export const DEFAULT_DISTRACTORS = 4

function describeTool(tool: NormalizedTool): string {
  const schema = tool.inputSchemaResolved
  const properties = isJsonObject(schema['properties']) ? Object.keys(schema['properties']) : []
  const required = Array.isArray(schema['required'])
    ? (schema['required'] as JsonValue[]).filter((name): name is string => typeof name === 'string')
    : []

  const parameters =
    properties.length === 0
      ? 'no parameters'
      : properties.map((name) => (required.includes(name) ? `${name} (required)` : name)).join(', ')

  return [
    `- name: ${tool.name}`,
    `  description: ${tool.description === '' ? '(none given)' : tool.description.replace(/\n/g, ' ')}`,
    `  parameters: ${parameters}`,
  ].join('\n')
}

export function buildGenerationPrompt(
  tools: readonly NormalizedTool[],
  options: GenerateOptions = {},
): string {
  const perTool = options.tasksPerTool ?? DEFAULT_TASKS_PER_TOOL
  const distractors = options.distractors ?? DEFAULT_DISTRACTORS

  return `You are helping to build an evaluation set for an MCP server's tools.

Here are the tools the server exposes:

${tools.map(describeTool).join('\n\n')}

Write ${perTool} natural-language requests for EACH tool above, plus ${distractors} distractors.

Rules for the requests:
- Write what a real user would type to an assistant. No mention of tool names, no JSON, no
  API vocabulary. "Show me everyone in the workspace", not "call list_users".
- Vary the phrasing: some questions, some commands, some terse, some with extra context.
- Each request must be answerable by exactly one of the tools above. If two tools could both
  plausibly serve a request, do not write it.

Rules for the distractors, which matter most:
- A distractor is a request that NONE of the tools above can satisfy.
- It must be plausible within this server's subject matter and just outside what the tools
  do. If the tools only read, a distractor that writes or deletes is ideal.
- Do NOT write off-topic filler. "What is the weather?" or "Write me a poem" are useless:
  any model refuses them, and the resulting score means nothing.

Reply with JSON only. No prose, no code fence, no explanation. This exact shape:

{
  "tasks": [
    { "id": "short.dotted.id", "prompt": "the user's words", "expected": "tool_name", "tags": ["read"] },
    { "id": "distractor.something", "prompt": "the user's words", "expected": null, "tags": ["distractor"] }
  ]
}

"expected" is the exact tool name for a request, or null for a distractor. Ids must be
unique, lowercase, and dotted.`
}

/** Pull the JSON object out of a reply that may be fenced or preceded by prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced?.[1] ?? text

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new WhichtoolError(
      'generate/no-json',
      "The model's reply contains no JSON object.",
      `It replied: ${text.slice(0, 200)}`,
    )
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch (cause) {
    throw new WhichtoolError(
      'generate/invalid-json',
      `The model's reply is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

export interface ParsedGeneration {
  tasks: Task[]
  diagnostics: Diagnostic[]
}

export function parseGeneratedTasks(payload: unknown, surface: Surface): ParsedGeneration {
  if (!isJsonObject(payload) || !Array.isArray(payload['tasks'])) {
    throw new WhichtoolError('generate/wrong-shape', "The model's reply has no `tasks` array.")
  }

  const toolNames = new Set(surface.tools.map((tool) => tool.name))
  const diagnostics: Diagnostic[] = []
  const tasks: Task[] = []
  const seenIds = new Set<string>()
  const seenPrompts = new Set<string>()

  for (const [index, raw] of (payload['tasks'] as JsonValue[]).entries()) {
    if (!isJsonObject(raw)) {
      diagnostics.push({
        code: 'generate/malformed-task',
        severity: 'warning',
        message: `Generated entry ${index} is not an object and was dropped.`,
      })
      continue
    }

    const prompt = raw['prompt']
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      diagnostics.push({
        code: 'generate/no-prompt',
        severity: 'warning',
        message: `Generated entry ${index} has no prompt and was dropped.`,
      })
      continue
    }

    const expected = raw['expected']
    if (expected !== null && typeof expected !== 'string') {
      diagnostics.push({
        code: 'generate/no-expected',
        severity: 'warning',
        message: `Generated entry ${index} ("${prompt.slice(0, 40)}") has no usable \`expected\` and was dropped.`,
      })
      continue
    }
    if (typeof expected === 'string' && !toolNames.has(expected)) {
      diagnostics.push({
        code: 'generate/invented-tool',
        severity: 'warning',
        message: `Generated entry ${index} expects \`${expected}\`, which is not on this surface. Dropped.`,
        detail: { expected, prompt: prompt.slice(0, 80) },
      })
      continue
    }

    const promptKey = prompt.trim().toLowerCase()
    if (seenPrompts.has(promptKey)) {
      diagnostics.push({
        code: 'generate/duplicate-prompt',
        severity: 'info',
        message: `Generated entry ${index} repeats an earlier prompt and was dropped.`,
      })
      continue
    }
    seenPrompts.add(promptKey)

    // Ids are regenerated when the model produced a duplicate or an unusable one, rather
    // than rejecting the task: the id is bookkeeping, the prompt is the content.
    const proposed =
      typeof raw['id'] === 'string' && raw['id'].trim() !== '' ? raw['id'].trim() : null
    let id = proposed ?? `${expected ?? 'distractor'}.${tasks.length}`
    if (seenIds.has(id)) {
      let suffix = 2
      while (seenIds.has(`${id}.${suffix}`)) suffix += 1
      id = `${id}.${suffix}`
    }
    seenIds.add(id)

    const rawTags = raw['tags']
    const tags =
      Array.isArray(rawTags) && rawTags.every((tag) => typeof tag === 'string')
        ? (rawTags as string[])
        : expected === null
          ? ['distractor']
          : []
    if (expected === null && !tags.includes('distractor')) tags.push('distractor')

    tasks.push({ id, prompt: prompt.trim(), expected, tags })
  }

  const covered = new Set(
    tasks.map((task) => task.expected).filter((name): name is string => name !== null),
  )
  const uncovered = [...toolNames].filter((name) => !covered.has(name)).sort()
  if (uncovered.length > 0) {
    diagnostics.push({
      code: 'generate/uncovered-tools',
      severity: 'warning',
      message: `The model wrote no task for ${uncovered.length} tools: ${uncovered.join(', ')}. Write those by hand, or generate again.`,
      tools: uncovered,
    })
  }
  if (!tasks.some((task) => task.expected === null)) {
    diagnostics.push({
      code: 'generate/no-distractors',
      severity: 'warning',
      message:
        'The model produced no distractors, so this set cannot measure over-triggering. Add some by hand before running it.',
    })
  }

  return { tasks, diagnostics }
}

export interface GenerationResult extends ParsedGeneration {
  taskSet: TaskSet
  /** The model's reply, kept so a bad generation can be inspected rather than guessed at. */
  raw: string
}

export async function generateTaskSet(
  provider: Provider,
  surface: Surface,
  options: GenerateOptions = {},
): Promise<GenerationResult> {
  if (provider.generate === undefined) {
    throw new WhichtoolError(
      'generate/provider-cannot-generate',
      `The \`${provider.id}\` provider cannot produce free-form text, so it cannot generate a task set.`,
      'Use a provider backed by a chat endpoint, or write the task set by hand - which is the more authoritative option anyway.',
    )
  }

  const request: GenerateRequest = {
    prompt: options.prompt ?? buildGenerationPrompt(surface.tools, options),

    temperature: options.temperature ?? 0.7,
    signal: options.signal,
  }

  const raw = await provider.generate(request)
  const parsed = parseGeneratedTasks(extractJson(raw), surface)

  return {
    ...parsed,
    raw,
    taskSet: {
      version: TASK_SET_VERSION,
      surface: surface.hash,
      tasks: parsed.tasks,
      source: '(generated)',
    },
  }
}
