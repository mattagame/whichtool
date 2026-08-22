import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, main } from '../src/cli/run.js'
import { planTrials } from '../src/core/eval/planner.js'
import { runTrials } from '../src/core/eval/runner.js'
import { scoreTrials } from '../src/core/eval/scorer.js'
import { createKeywordProvider, createMockProvider } from '../src/core/providers/mock.js'
import { createOpenAiCompatibleProvider } from '../src/core/providers/openai-compatible.js'
import { renderRunTerminal } from '../src/core/report/run-terminal.js'
import { buildRunReport, estimateRun, RUN_SCHEMA_VERSION } from '../src/core/run.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import { parseTaskSet } from '../src/core/tasks/load.js'
import { snapshotTransportFromData } from '../src/core/transport/index.js'
import { createFakeRuntime, fixturePath, readFixture, REPO_ROOT } from './helpers.js'
import type { FakeRuntimeOptions } from './helpers.js'

const TASKS_FILE = join(REPO_ROOT, 'tests', 'fixtures', 'tasks', 'list-search.tasks.yaml')

async function fullRun(
  provider: ReturnType<typeof createKeywordProvider>,
  options: {
    repeat?: number
    thresholds?: Parameters<typeof buildRunReport>[0]['thresholds']
    upstreamDiagnostics?: Parameters<typeof buildRunReport>[0]['upstreamDiagnostics']
  } = {},
) {
  const surface = await loadSurface(
    snapshotTransportFromData(readFixture('list-search-pair.json'), 'list-search-pair.json'),
  )
  const taskSet = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), TASKS_FILE)
  const plan = planTrials(taskSet.tasks, surface.tools, { repeat: options.repeat ?? 2, seed: 1 })
  const executed = await runTrials(plan, taskSet.tasks, surface.tools, provider, { concurrency: 4 })
  const scored = scoreTrials(executed.outcomes, surface.tools)

  return buildRunReport({
    surface,
    taskSet,
    selected: taskSet.tasks,
    plan,
    trials: scored,
    durationMs: executed.durationMs,
    provider: {
      id: provider.id,
      model: provider.model,
      endpoint: provider.endpoint,
      capabilities: provider.capabilities,
    },
    temperature: 0,
    concurrency: 4,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.upstreamDiagnostics === undefined
      ? {}
      : { upstreamDiagnostics: options.upstreamDiagnostics }),
  })
}

/** A provider that answers by keyword, close to what a competent model would do. */
function competentProvider() {
  return createKeywordProvider(
    {
      roster: 'list_users',
      'all the users': 'list_users',
      'next page': 'list_users',
      contains: 'search_users',
      matching: 'search_users',
      'look up': 'get_user',
      'how many': 'count_users',
    },
    { argumentsFor: (pick) => (pick === 'search_users' ? { query: 'rossi' } : null) },
  )
}

describe('a run end to end', () => {
  test('plans repeat trials per task and scores every one', async () => {
    const report = await fullRun(competentProvider(), { repeat: 2 })
    expect(report.schemaVersion).toBe(RUN_SCHEMA_VERSION)
    expect(report.metrics.trials.planned).toBe(20)
    expect(report.metrics.trials.errored).toBe(0)
  })

  test('a competent model scores well and refuses the distractors', async () => {
    const report = await fullRun(competentProvider(), { repeat: 2 })
    expect(report.metrics.accuracy.value).toBe(1)
    expect(report.metrics.accuracy.denominator).toBe(14)
    expect(report.metrics.overTrigger.value).toBe(0)
    expect(report.metrics.overTrigger.denominator).toBe(6)
  })

  test('the tool order really did vary between trials', async () => {
    const provider = competentProvider()
    await fullRun(provider, { repeat: 3 })
    const orders = new Set(provider.calls.map((call) => call.tools.map((t) => t.name).join(' ')))
    expect(orders.size).toBeGreaterThan(1)
  })

  test('the prompt is sent bare, with no system message and nothing appended', async () => {
    const provider = competentProvider()
    await fullRun(provider, { repeat: 1 })
    const set = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), TASKS_FILE)
    const prompts = new Set(provider.calls.map((call) => call.prompt))
    for (const task of set.tasks) expect(prompts.has(task.prompt)).toBe(true)
  })

  test('a model that always picks list_users produces the confusion pair', async () => {
    const always = createKeywordProvider({ '': 'list_users' })
    const report = await fullRun(always, { repeat: 2 })
    const pair = report.metrics.confusionPairs[0]
    expect(pair?.tools).toContain('list_users')
    expect(report.metrics.overTrigger.value).toBe(1)
    expect(
      report.diagnostics.find((diagnostic) => diagnostic.code === 'run/confusion-pair'),
    ).toMatchObject({ severity: 'warning' })
    expect(report.ok).toBe(true)
  })

  test('an error-severity upstream diagnostic makes the machine verdict fail', async () => {
    const report = await fullRun(competentProvider(), {
      upstreamDiagnostics: [
        {
          code: 'surface/duplicate-tool-name',
          severity: 'error',
          message: 'Duplicate tool name.',
        },
      ],
    })

    expect(report.execution.ok).toBe(true)
    expect(report.thresholdsOk).toBe(true)
    expect(report.ok).toBe(false)
  })

  test('preserves multiple calls and reports them as an explicit failed selection mode', async () => {
    const multi = createMockProvider({
      cycle: true,
      script: [
        {
          pick: 'list_users',
          calls: [
            { name: 'list_users', arguments: null },
            { name: 'search_users', arguments: { query: 'also do this' } },
          ],
        },
      ],
    })
    const report = await fullRun(multi as never, { repeat: 1 })

    expect(report.metrics.multiCallRate).toMatchObject({ numerator: 10, denominator: 10 })
    expect(report.trials.every((trial) => trial.calls.length === 2)).toBe(true)
    expect(report.trials.some((trial) => trial.verdict === 'unexpected-additional-calls')).toBe(
      true,
    )
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'run/unexpected-additional-calls',
    )
  })

  test('turns malformed custom-provider calls into error trials instead of invalid run reports', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const sparse = new Array<unknown>(1)
    const malformedCallLists: unknown[][] = [
      [{}],
      [{ name: 42, arguments: null }],
      [{ name: 'list_users', arguments: [] }],
      [{ name: 'list_users', arguments: { missing: undefined } }],
      [{ name: 'list_users', arguments: cyclic }],
      [{ name: 'list_users', arguments: null, rawArguments: 42 }],
      sparse,
    ]

    for (const calls of malformedCallLists) {
      const malformed = createMockProvider({
        cycle: true,
        script: () => ({ pick: null, calls: calls as never }),
      })
      const report = await fullRun(malformed as never, { repeat: 1 })

      expect(report.trials.every((trial) => trial.verdict === 'error')).toBe(true)
      expect(
        report.trials.every(
          (trial) =>
            trial.calls.length === 0 &&
            trial.callCount === 0 &&
            trial.pick === null &&
            trial.arguments === null,
        ),
      ).toBe(true)
      expect(report.trials[0]?.error?.message).toContain('malformed tool call')
    }
  })

  test('provider failures are reported and kept out of the rates', async () => {
    const flaky = createMockProvider({
      cycle: true,
      script: [
        { pick: 'list_users' },
        { pick: null, error: { message: '429 slow down', retryable: true } },
      ],
    })
    const report = await fullRun(flaky as never, { repeat: 2 })
    expect(report.metrics.trials.errored).toBe(10)
    expect(report.metrics.accuracy.denominator).toBe(7)
    expect(report.diagnostics.map((d) => d.code)).toContain('run/errored-trials')
    expect(report.execution.ok).toBe(false)
    expect(report.ok).toBe(false)
  })

  test('a provider that fails every trial produces an invalid run, never a passing empty rate', async () => {
    const failed = createMockProvider({
      cycle: true,
      script: [{ pick: null, error: { message: 'provider unavailable', retryable: true } }],
    })
    const report = await fullRun(failed as never, { repeat: 1 })

    expect(report.execution).toMatchObject({
      ok: false,
      planned: 10,
      completed: 10,
      scored: 0,
      errored: 10,
      maxErrorRate: 0.1,
      minScored: 1,
    })
    expect(report.ok).toBe(false)
    expect(
      report.diagnostics.find((diagnostic) => diagnostic.code === 'run/errored-trials'),
    ).toMatchObject({ severity: 'error' })
  })

  test('thresholds decide `ok`, and an unmeasured rate fails rather than passes', async () => {
    const good = await fullRun(competentProvider(), { thresholds: { minAccuracy: 0.9 } })
    expect(good.ok).toBe(true)

    const bad = await fullRun(createKeywordProvider({}), { thresholds: { minAccuracy: 0.9 } })
    expect(bad.ok).toBe(false)
    expect(bad.thresholds[0]).toMatchObject({ name: 'minAccuracy', ok: false })
  })

  test('records everything needed to say whether two runs are comparable', async () => {
    const report = await fullRun(competentProvider())
    expect(report.reproducibility).toMatchObject({
      provider: 'mock',
      temperature: 0,
      repeat: 2,
      permuted: true,
      concurrency: 4,
    })
    expect(report.reproducibility.surfaceHash).toMatch(/^sha256:/)
    expect(report.reproducibility.taskSetVersion).toBe(1)
  })

  test('--no-permute is called out as making the accuracy uninterpretable', async () => {
    const surface = await loadSurface(
      snapshotTransportFromData(readFixture('list-search-pair.json'), 's'),
    )
    const taskSet = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), TASKS_FILE)
    const plan = planTrials(taskSet.tasks, surface.tools, { repeat: 1, permute: false })
    const provider = competentProvider()
    const executed = await runTrials(plan, taskSet.tasks, surface.tools, provider, {})
    const report = buildRunReport({
      surface,
      taskSet,
      selected: taskSet.tasks,
      plan,
      trials: scoreTrials(executed.outcomes, surface.tools),
      durationMs: 0,
      provider: {
        id: provider.id,
        model: provider.model,
        endpoint: provider.endpoint,
        capabilities: provider.capabilities,
      },
      temperature: 0,
      concurrency: 1,
    })
    expect(report.diagnostics.map((d) => d.code)).toContain('run/not-permuted')
  })

  test('the terminal report always shows abstention and over-trigger together', async () => {
    const report = await fullRun(competentProvider())
    const rendered = renderRunTerminal(report, { color: false, width: 88 })
    expect(rendered).toContain('abstention')
    expect(rendered).toContain('over-trigger')
    expect(rendered).toContain('Confusion matrix')
    expect(rendered).toContain('No tool was executed.')
    // Every rate carries its denominator (SPEC §3.2).
    expect(rendered).toMatch(/single-call\s+\d+\/\d+/)
  })

  test('the terminal report is pure ASCII', async () => {
    const report = await fullRun(competentProvider())
    const rendered = renderRunTerminal(report, { color: false, width: 88 })
    expect([...new Set(rendered.match(/[^\u0000-\u007F]/g) ?? [])]).toEqual([])
  })
})

describe('estimateRun', () => {
  test('rejects invalid concurrency instead of creating a zero-worker estimate', async () => {
    const surface = await loadSurface(snapshotTransportFromData(readFixture('clean.json'), 's'))
    const taskSet = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), TASKS_FILE)
    const plan = planTrials(taskSet.tasks, surface.tools, { repeat: 1 })
    expect(() => estimateRun(plan, surface, taskSet.tasks, { concurrency: 0 })).toThrow(
      'between 1 and 64',
    )
  })

  test('counts trials and prompt tokens without calling anything', async () => {
    const surface = await loadSurface(
      snapshotTransportFromData(readFixture('list-search-pair.json'), 's'),
    )
    const taskSet = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), TASKS_FILE)
    const plan = planTrials(taskSet.tasks, surface.tools, { repeat: 5 })
    const estimate = estimateRun(plan, surface, taskSet.tasks, { concurrency: 4 })

    expect(estimate.trials).toBe(50)
    expect(estimate.promptTokensPerTrial).toBeGreaterThan(surface.tokens.total)
    expect(estimate.totalPromptTokens).toBe(estimate.promptTokensPerTrial * 50)
    // No measured latency was supplied, so no time is invented.
    expect(estimate.estimatedSeconds).toBeNull()
  })

  test('estimates wall clock only from a figure the caller measured', async () => {
    const surface = await loadSurface(
      snapshotTransportFromData(readFixture('list-search-pair.json'), 's'),
    )
    const taskSet = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), TASKS_FILE)
    const plan = planTrials(taskSet.tasks, surface.tools, { repeat: 2 })
    const estimate = estimateRun(plan, surface, taskSet.tasks, {
      concurrency: 4,
      secondsPerTrial: 50,
    })
    expect(estimate.estimatedSeconds).toBe(Math.ceil((20 * 50) / 4))
  })
})

test('provider cancellation keeps the request timeout in place', async () => {
  let sentSignal: AbortSignal | null | undefined
  const provider = createOpenAiCompatibleProvider({
    baseUrl: 'https://example.test/v1',
    model: 'test',
    retries: 0,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      sentSignal = init?.signal
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
        {
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch,
  })
  const surface = await loadSurface(
    snapshotTransportFromData(readFixture('clean.json'), 'clean.json'),
  )
  const controller = new AbortController()
  await provider.pick({
    tools: surface.tools,
    prompt: 'do nothing',
    temperature: 0,
    signal: controller.signal,
  })

  expect(sentSignal).not.toBe(controller.signal)
  controller.abort()
  expect(sentSignal?.aborted).toBe(true)
})

async function cli(argv: string[], options: FakeRuntimeOptions = {}) {
  const runtime = createFakeRuntime(options)
  const code = await main(argv, runtime)
  return { code, out: runtime.out(), err: runtime.err() }
}

describe('the CLI', () => {
  test('`tasks lint` passes on the committed fixture', async () => {
    const { code, out } = await cli([
      'tasks',
      'lint',
      fixturePath('list-search-pair.json'),
      '--tasks',
      TASKS_FILE,
    ])
    expect(code).toBe(EXIT.ok)
    expect(out).toContain('4/4 tools covered')
    expect(out).toContain('No errors.')
  })

  test('`tasks lint` says which checks it skipped without a target', async () => {
    const { out } = await cli(['tasks', 'lint', '--tasks', TASKS_FILE])
    expect(out).toContain('not checked: no target given')
  })

  test('`tasks lint --format json` is machine readable', async () => {
    const { out } = await cli(['tasks', 'lint', '--tasks', TASKS_FILE, '--format', 'json'])
    const parsed = JSON.parse(out) as { ok: boolean; surfaceChecked: boolean }
    expect(parsed.ok).toBe(true)
    expect(parsed.surfaceChecked).toBe(false)
  })

  test('`tasks lint` exits 1 on an error, not 2', async () => {
    const { code } = await cli(['tasks', 'lint', fixturePath('clean.json'), '--tasks', TASKS_FILE])
    // The fixture expects tools that clean.json does not expose.
    expect(code).toBe(EXIT.thresholdViolated)
  })

  test('`run --dry-run` calls no model and refuses to invent a wall-clock figure', async () => {
    const { code, out } = await cli([
      'run',
      fixturePath('list-search-pair.json'),
      '--tasks',
      TASKS_FILE,
      '--repeat',
      '3',
      '--dry-run',
    ])
    expect(code).toBe(EXIT.ok)
    expect(out).toContain('trials       30')
    expect(out).toContain('wall clock   unknown')
    expect(out).toContain('No model was called.')
  })

  test('`run --dry-run --seconds-per-trial` estimates the time too', async () => {
    const { out } = await cli([
      'run',
      fixturePath('list-search-pair.json'),
      '--tasks',
      TASKS_FILE,
      '--repeat',
      '2',
      '--concurrency',
      '4',
      '--dry-run',
      '--seconds-per-trial',
      '50',
    ])
    expect(out).toContain('wall clock   ~5 min')
  })

  test('`run` with the mock provider produces a full report', async () => {
    const { code, out } = await cli([
      'run',
      fixturePath('list-search-pair.json'),
      '--tasks',
      TASKS_FILE,
      '--provider',
      'mock',
      '--repeat',
      '1',
    ])
    expect(code).toBe(EXIT.ok)
    expect(out).toContain('whichtool run')
    expect(out).toContain('Confusion pairs')
    // The default mock abstains on everything, so that is what the report must show.
    expect(out).toContain('abstention')
  })

  test('`run` and `report` exit 1 for an error diagnostic on an otherwise healthy run', async () => {
    const target = join(REPO_ROOT, 'duplicate-tool-surface.json')
    const source = readFixture('list-search-pair.json') as { tools: unknown[] }
    const duplicated = JSON.stringify({
      ...source,
      tools: [...source.tools, source.tools[0]],
    })
    const first = await cli(
      [
        'run',
        target,
        '--tasks',
        TASKS_FILE,
        '--provider',
        'mock',
        '--repeat',
        '1',
        '--format',
        'json',
        '--no-cache',
      ],
      { files: { [target]: duplicated } },
    )
    const report = JSON.parse(first.out) as {
      ok: boolean
      execution: { ok: boolean }
      diagnostics: Array<{ code: string; severity: string }>
    }
    expect(first.code).toBe(EXIT.thresholdViolated)
    expect(report).toMatchObject({ ok: false, execution: { ok: true } })
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'surface/duplicate-tool-name', severity: 'error' }),
    )

    const reportPath = join(REPO_ROOT, 'analysis-error-run.json')
    const rerendered = await cli(['report', reportPath, '--format', 'json'], {
      files: { [reportPath]: first.out },
    })
    expect(rerendered.code).toBe(EXIT.thresholdViolated)
  })

  test('`run` exits 1 when a threshold fails', async () => {
    const { code } = await cli([
      'run',
      fixturePath('list-search-pair.json'),
      '--tasks',
      TASKS_FILE,
      '--provider',
      'mock',
      '--repeat',
      '1',
      '--min-accuracy',
      '0.9',
    ])
    expect(code).toBe(EXIT.thresholdViolated)
  })

  test('`run` refuses a task set whose expected tools are not on the surface', async () => {
    const { code, err } = await cli([
      'run',
      fixturePath('clean.json'),
      '--tasks',
      TASKS_FILE,
      '--provider',
      'mock',
    ])
    expect(code).toBe(EXIT.error)
    expect(err).toContain('expected-not-on-surface')
  })

  test('`run --only` narrows the task set', async () => {
    const { out } = await cli([
      'run',
      fixturePath('list-search-pair.json'),
      '--tasks',
      TASKS_FILE,
      '--only',
      'distractor',
      '--repeat',
      '2',
      '--dry-run',
    ])
    expect(out).toContain('tasks        3 selected of 10')
  })

  test('`run --format json` emits the versioned report', async () => {
    const { out } = await cli([
      'run',
      fixturePath('list-search-pair.json'),
      '--tasks',
      TASKS_FILE,
      '--provider',
      'mock',
      '--repeat',
      '1',
      '--format',
      'json',
    ])
    const parsed = JSON.parse(out) as { schemaVersion: string; reproducibility: { model: string } }
    expect(parsed.schemaVersion).toBe(RUN_SCHEMA_VERSION)
    expect(parsed.reproducibility.model).toBe('mock-1')
  })

  test('`run --help` describes the command rather than the whole CLI', async () => {
    const { code, out } = await cli(['run', '--help'])
    expect(code).toBe(EXIT.ok)
    expect(out).toContain('whichtool run <target>')
    expect(out).toContain('--min-accuracy')
    expect(out).toContain('--no-cache')
    expect(out).toContain('never executes a tool')
  })
})
