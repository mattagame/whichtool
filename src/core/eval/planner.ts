import type { NormalizedTool } from '../types.js'
import { WhichtoolError } from '../errors.js'
import type { Task } from '../tasks/schema.js'
import { assertRepeat, assertSeed, MAX_PLANNED_TRIALS } from './options.js'

export function hashString(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function trialSeed(runSeed: number, taskId: string, trialIndex: number): number {
  return (
    (hashString(`${runSeed}:${taskId}:${trialIndex}`) ^ Math.imul(trialIndex + 1, 0x9e3779b9)) >>> 0
  )
}

/** Fisher-Yates, driven by a seeded PRNG. */
export function permute<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const a = out[index] as T
    out[index] = out[swap] as T
    out[swap] = a
  }
  return out
}

export interface Trial {
  taskId: string
  /** 0-based index of this repetition of the task. */
  trialIndex: number
  /** Tool names in the order they will be presented to the model. */
  order: string[]
  /** Where the expected tool sits in `order`; -1 for a distractor. */
  expectedPosition: number
  seed: number
}

export interface PlanOptions {
  repeat?: number
  permute?: boolean
  seed?: number
}

export interface TrialPlan {
  trials: Trial[]
  repeat: number
  permuted: boolean
  seed: number
  taskCount: number
  toolCount: number
}

export const DEFAULT_REPEAT = 5
export const DEFAULT_SEED = 0

/** How hard to try for a distinct order before accepting a repeat. */
const DISTINCT_ORDER_ATTEMPTS = 24

function factorialCappedAt(n: number, cap: number): number {
  let total = 1
  for (let index = 2; index <= n; index += 1) {
    total *= index
    if (total >= cap) return cap
  }
  return total
}

export function planTrials(
  tasks: readonly Task[],
  tools: readonly NormalizedTool[],
  options: PlanOptions = {},
): TrialPlan {
  if (tasks.length === 0) {
    throw new WhichtoolError('trials/empty-task-set', 'Cannot plan a run with an empty task set.')
  }

  const repeat = assertRepeat(options.repeat ?? DEFAULT_REPEAT)
  const shouldPermute = options.permute ?? true
  if (typeof shouldPermute !== 'boolean') {
    throw new WhichtoolError(
      'trials/invalid-permute',
      `permute must be a boolean; received ${String(shouldPermute)}.`,
    )
  }
  const seed = assertSeed(options.seed ?? DEFAULT_SEED)
  const plannedCount = tasks.length * repeat
  if (!Number.isSafeInteger(plannedCount) || plannedCount > MAX_PLANNED_TRIALS) {
    throw new WhichtoolError(
      'trials/plan-too-large',
      `Run would create ${String(plannedCount)} trials; the limit is ${MAX_PLANNED_TRIALS}.`,
    )
  }

  // The served order, which is what a client would actually send with `--no-permute`.
  const servedOrder = [...tools]
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((t) => t.name)
  const distinctOrders = factorialCappedAt(servedOrder.length, repeat + 1)

  const trials: Trial[] = []
  for (const task of tasks) {
    const used = new Set<string>()

    for (let trialIndex = 0; trialIndex < repeat; trialIndex += 1) {
      const base = trialSeed(seed, task.id, trialIndex)
      let order = servedOrder

      if (shouldPermute && servedOrder.length > 1) {
        // Resample for a distinct order while distinct orders remain. Two trials landing
        // on the same permutation by chance would understate position sensitivity, which
        // is precisely the quantity the permutation exists to expose.
        for (let attempt = 0; attempt < DISTINCT_ORDER_ATTEMPTS; attempt += 1) {
          const candidate = permute(servedOrder, createRandom((base + attempt * 0x85ebca6b) >>> 0))
          const key = candidate.join(String.fromCharCode(0))
          if (!used.has(key) || used.size >= distinctOrders) {
            order = candidate
            used.add(key)
            break
          }
          order = candidate
        }
      }

      trials.push({
        taskId: task.id,
        trialIndex,
        order,
        expectedPosition: task.expected === null ? -1 : order.indexOf(task.expected),
        seed: base,
      })
    }
  }

  return {
    trials,
    repeat,
    permuted: shouldPermute,
    seed,
    taskCount: tasks.length,
    toolCount: servedOrder.length,
  }
}

/** Reorder the tool definitions for a trial. Names not on the surface are skipped. */
export function orderTools(
  tools: readonly NormalizedTool[],
  order: readonly string[],
): NormalizedTool[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const out: NormalizedTool[] = []
  for (const name of order) {
    const tool = byName.get(name)
    if (tool !== undefined) out.push(tool)
  }
  return out
}
