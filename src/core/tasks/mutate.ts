import { createRandom, hashString } from '../eval/planner.js'
import type { Diagnostic } from '../types.js'
import type { Task } from './schema.js'

export type Mutation = (prompt: string, random: () => number) => string | null

const NEIGHBOURS: Record<string, string> = {
  a: 'qsz',
  b: 'vgn',
  c: 'xdv',
  d: 'sfce',
  e: 'wrd',
  f: 'dgrv',
  g: 'fhtb',
  h: 'gjyn',
  i: 'uok',
  j: 'hkun',
  k: 'jlim',
  l: 'kop',
  m: 'njk',
  n: 'bmhj',
  o: 'ipl',
  p: 'ol',
  q: 'wa',
  r: 'etf',
  s: 'adwx',
  t: 'ryg',
  u: 'yih',
  v: 'cfb',
  w: 'qes',
  x: 'zsc',
  y: 'tuh',
  z: 'asx',
}

export const typo: Mutation = (prompt, random) => {
  const positions: number[] = []
  for (let index = 1; index < prompt.length; index += 1) {
    const char = prompt[index] as string
    const previous = prompt[index - 1] as string
    if (/[a-z]/i.test(char) && /[a-z]/i.test(previous)) positions.push(index)
  }
  if (positions.length < 3) return null

  const count = 1 + Math.floor(random() * 2)
  const chosen = new Set<number>()
  for (let attempt = 0; attempt < count * 6 && chosen.size < count; attempt += 1) {
    chosen.add(positions[Math.floor(random() * positions.length)] as number)
  }

  const characters = [...prompt]
  for (const index of [...chosen].sort((a, b) => b - a)) {
    const char = characters[index] as string
    const lower = char.toLowerCase()
    const roll = random()

    if (roll < 0.4 && NEIGHBOURS[lower] !== undefined) {
      const options = NEIGHBOURS[lower] as string
      characters[index] = options[Math.floor(random() * options.length)] as string
    } else if (roll < 0.7) {
      characters.splice(index, 0, char)
    } else if (index + 1 < characters.length) {
      const next = characters[index + 1] as string
      characters[index] = next
      characters[index + 1] = char
    } else {
      characters.splice(index, 1)
    }
  }
  const mutated = characters.join('')
  return mutated === prompt ? null : mutated
}

const FILLER =
  /^(please\s+|could you\s+|can you\s+|would you\s+|i(?:'| a)?m wondering\s+|i want to\s+|i need to\s+|hey,?\s+)/i

export const casual: Mutation = (prompt) => {
  let text = prompt.trim()
  let changed = false

  const stripped = text.replace(FILLER, '')
  if (stripped !== text) {
    text = stripped
    changed = true
  }
  const unpunctuated = text.replace(/[.?!]+$/, '')
  if (unpunctuated !== text) {
    text = unpunctuated
    changed = true
  }
  const lowered = text.charAt(0).toLowerCase() + text.slice(1)
  if (lowered !== text) {
    text = lowered
    changed = true
  }
  return changed && text.trim() !== '' ? text.trim() : null
}

const POLITE_CLOSERS = ['? Thanks.', "? I'd appreciate it.", ", if you don't mind?"]

export const polite: Mutation = (prompt, random) => {
  const text = prompt.trim()
  if (FILLER.test(text) || text.endsWith('?')) return null

  const body = text.charAt(0).toLowerCase() + text.slice(1).replace(/[.!]+$/, '')
  const closer = POLITE_CLOSERS[Math.floor(random() * POLITE_CLOSERS.length)] as string
  return `Could you please ${body}${closer}`
}

/**
 * A question turned into a command.
 *
 * Only the patterns that convert cleanly; anything else returns null. A half-converted
 * question reads like neither, and would measure the mutation rather than the surface.
 */
export const imperative: Mutation = (prompt) => {
  const text = prompt.trim()
  if (!text.endsWith('?')) return null
  const body = text.slice(0, -1).trim()

  const assistant = /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(.+)$/i.exec(body)
  if (assistant?.[1] !== undefined) {
    const verb = assistant[1]
    return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}.`
  }

  const wh = /^(how many|what|which|who|where|when)\b(.*)$/i.exec(body)
  if (wh !== null) {
    return `Tell me ${wh[1]?.toLowerCase() ?? ''}${wh[2] ?? ''}.`
  }
  return null
}

/** A command turned into a question, for the same reason and with the same restraint. */
export const interrogative: Mutation = (prompt) => {
  const text = prompt.trim()
  if (text.endsWith('?')) return null
  const body = text.replace(/[.!]+$/, '').trim()

  const command = /^(show|list|find|get|give|fetch|search|look up|tell)\b(.*)$/i.exec(body)
  if (command === null) return null
  return `Could you ${command[1]?.toLowerCase() ?? ''}${command[2] ?? ''}?`
}

export const MUTATIONS: Record<string, Mutation> = {
  typo,
  casual,
  polite,
  imperative,
  interrogative,
}

export const MUTATION_NAMES = Object.keys(MUTATIONS).sort()

export interface MutateOptions {
  /** Which mutations to apply. Defaults to all of them. */
  mutations?: readonly string[]
  /** Fixed seed, so the produced set is identical on every machine. */
  seed?: number
  /** Keep the originals alongside the variants. On by default. */
  keepOriginals?: boolean
}

export interface MutationResult {
  tasks: Task[]
  diagnostics: Diagnostic[]
  /** How many variants each mutation produced, and how many prompts it declined. */
  applied: Record<string, { produced: number; skipped: number }>
}

export function mutateTasks(tasks: readonly Task[], options: MutateOptions = {}): MutationResult {
  const names = options.mutations ?? MUTATION_NAMES
  const seed = options.seed ?? 0
  const diagnostics: Diagnostic[] = []
  const applied: Record<string, { produced: number; skipped: number }> = {}

  for (const name of names) {
    if (MUTATIONS[name] === undefined) {
      throw new Error(`unknown mutation \`${name}\`; available: ${MUTATION_NAMES.join(', ')}`)
    }
    applied[name] = { produced: 0, skipped: 0 }
  }

  const out: Task[] = options.keepOriginals === false ? [] : [...tasks]
  // Compared exactly, not case-insensitively: `casual` exists to change capitalisation, and
  // folding case here would make it look like a duplicate of its own original every time.
  const seenPrompts = new Set(tasks.map((task) => task.prompt.trim()))

  for (const task of tasks) {
    // Mutations of a mutation compound into noise, so a derived task is never re-derived.
    if (task.derivedFrom !== undefined) continue

    for (const name of names) {
      const mutation = MUTATIONS[name] as Mutation
      const random = createRandom(hashString(`${seed}:${task.id}:${name}`))
      const mutated = mutation(task.prompt, random)
      const stats = applied[name] as { produced: number; skipped: number }

      if (mutated === null) {
        stats.skipped += 1
        continue
      }
      const key = mutated.trim()
      if (seenPrompts.has(key)) {
        stats.skipped += 1
        continue
      }
      seenPrompts.add(key)
      stats.produced += 1

      out.push({
        id: `${task.id}.${name}`,
        prompt: mutated,
        expected: task.expected,
        tags: [...task.tags, 'mutated', name],
        derivedFrom: { taskId: task.id, mutation: name },
      })
    }
  }

  for (const [name, stats] of Object.entries(applied)) {
    if (stats.produced > 0) continue
    diagnostics.push({
      code: 'mutate/never-applied',
      severity: 'info',
      message: `\`${name}\` produced nothing: it did not apply to any of the ${tasks.length} prompts. That is the mutation declining rather than failing.`,
      detail: { mutation: name, skipped: stats.skipped },
    })
  }

  const derived = out.length - (options.keepOriginals === false ? 0 : tasks.length)
  if (derived > 0) {
    diagnostics.push({
      code: 'mutate/produced',
      severity: 'info',
      message: `${derived} variants added across ${tasks.length} original tasks. Every variant keeps its original's \`expected\`, so a variant the model gets wrong is a robustness failure, not an ambiguity.`,
      detail: { derived, originals: tasks.length },
    })
  }

  return { tasks: out, diagnostics, applied }
}
