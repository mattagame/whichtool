import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { withInterruptSignal } from '../src/cli/signals.js'
import { planTrials } from '../src/core/eval/planner.js'
import { runTrials } from '../src/core/eval/runner.js'
import { createOpenAiCompatibleProvider } from '../src/core/providers/openai-compatible.js'
import { ProviderError, type Provider } from '../src/core/providers/types.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import type { Task } from '../src/core/tasks/schema.js'
import { snapshotTransportFromData } from '../src/core/transport/index.js'
import { caught, readFixture } from './helpers.js'

describe('the human CLI interrupt bridge', () => {
  test('turns the first SIGINT into an AbortSignal and removes its one-shot listener', async () => {
    const host = new EventEmitter()
    const pending = withInterruptSignal(host, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      return signal.aborted
    })

    expect(host.listenerCount('SIGINT')).toBe(1)
    host.emit('SIGINT')

    expect(await pending).toEqual({ result: true, interrupted: true })
    expect(host.listenerCount('SIGINT')).toBe(0)
  })

  test('removes the handler after an uninterrupted command too', async () => {
    const host = new EventEmitter()
    const completed = await withInterruptSignal(host, async (signal) => signal.aborted)

    expect(completed).toEqual({ result: false, interrupted: false })
    expect(host.listenerCount('SIGINT')).toBe(0)
  })
})

test('an abort during explicit HTTP retry backoff returns promptly and sends no retry', async () => {
  const controller = new AbortController()
  let requests = 0
  const provider = createOpenAiCompatibleProvider({
    baseUrl: 'https://example.test/v1',
    model: 'test',
    retries: 3,
    fetch: (async () => {
      requests += 1
      if (requests === 1) setTimeout(() => controller.abort(), 10)
      return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 })
    }) as unknown as typeof fetch,
  })

  const completion = caught(
    provider.pick({
      tools: [],
      prompt: 'stop',
      temperature: 0,
      signal: controller.signal,
    }),
  )
  let guard: ReturnType<typeof setTimeout> | undefined
  const timedOut = Symbol('timed-out')
  const result = await Promise.race([
    completion,
    new Promise<typeof timedOut>((resolve) => {
      guard = setTimeout(() => resolve(timedOut), 200)
    }),
  ])
  if (guard !== undefined) clearTimeout(guard)

  expect(result).not.toBe(timedOut)
  expect(result).toBeInstanceOf(ProviderError)
  expect((result as ProviderError).retryable).toBe(false)
  expect(requests).toBe(1)
})

test('the runner stops progress output once its signal is aborted', async () => {
  const surface = await loadSurface(
    snapshotTransportFromData(readFixture('clean.json'), 'clean.json'),
  )
  const tasks: Task[] = [
    {
      id: 'stop',
      prompt: 'Stop now.',
      expected: null,
      tags: [],
    },
  ]
  const plan = planTrials(tasks, surface.tools, { repeat: 2 })
  const controller = new AbortController()
  let progress = 0
  const provider: Provider = {
    id: 'abort-test',
    model: 'abort-test',
    endpoint: null,
    capabilities: {
      seed: false,
      temperatureZero: true,
      logprobs: false,
      disableThinking: true,
    },
    async pick() {
      controller.abort()
      throw new ProviderError('cancelled', { retryable: false })
    },
  }

  const executed = await runTrials(plan, tasks, surface.tools, provider, {
    concurrency: 1,
    signal: controller.signal,
    onTrial: () => {
      progress += 1
    },
  })

  expect(executed.cancelled).toBe(true)
  expect(executed.outcomes).toHaveLength(1)
  expect(progress).toBe(0)
})
