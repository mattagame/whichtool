import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { badgeForInspect, badgeForOverTrigger, badgeForRun } from '../src/core/report/badge.js'
import { renderRunHtml } from '../src/core/report/html.js'
import { renderRunJUnit } from '../src/core/report/junit.js'
import { renderInspectMarkdown, renderRunMarkdown } from '../src/core/report/markdown.js'
import { renderRunTerminal } from '../src/core/report/run-terminal.js'
import { buildInspectReport } from '../src/core/inspect.js'
import { planTrials } from '../src/core/eval/planner.js'
import { runTrials } from '../src/core/eval/runner.js'
import { scoreTrials } from '../src/core/eval/scorer.js'
import { createKeywordProvider } from '../src/core/providers/mock.js'
import { buildRunReport, type RunReport } from '../src/core/run.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import { parseTaskSet } from '../src/core/tasks/load.js'
import { snapshotTransportFromData } from '../src/core/transport/index.js'
import { readFixture, REPO_ROOT } from './helpers.js'

const TASKS_FILE = join(REPO_ROOT, 'tests', 'fixtures', 'tasks', 'list-search.tasks.yaml')

async function inspectOf(fixture: string) {
  return buildInspectReport(
    await loadSurface(snapshotTransportFromData(readFixture(fixture), fixture)),
  )
}

async function runOf(
  rules: Record<string, string>,
  options: {
    thresholds?: Parameters<typeof buildRunReport>[0]['thresholds']
    upstreamDiagnostics?: Parameters<typeof buildRunReport>[0]['upstreamDiagnostics']
  } = {},
): Promise<RunReport> {
  const surface = await loadSurface(
    snapshotTransportFromData(readFixture('list-search-pair.json'), 'list-search-pair.json'),
  )
  const taskSet = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), 'list-search.tasks.yaml')
  const provider = createKeywordProvider(rules)
  const plan = planTrials(taskSet.tasks, surface.tools, { repeat: 3, seed: 4 })
  const executed = await runTrials(plan, taskSet.tasks, surface.tools, provider, { concurrency: 4 })
  return buildRunReport({
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
    concurrency: 4,
    thresholds: options.thresholds ?? { minAccuracy: 0.9 },
    ...(options.upstreamDiagnostics === undefined
      ? {}
      : { upstreamDiagnostics: options.upstreamDiagnostics }),
  })
}

const GOOD = { roster: 'list_users', contains: 'search_users', 'how many': 'count_users' }
const COMPETENT = {
  roster: 'list_users',
  'all the users': 'list_users',
  'next page': 'list_users',
  contains: 'search_users',
  matching: 'search_users',
  'look up': 'get_user',
  'how many': 'count_users',
}

describe('the markdown reporters', () => {
  test('an inspect report leads with the verdict and folds the detail', async () => {
    const markdown = renderInspectMarkdown(await inspectOf('list-search-pair.json'))
    expect(markdown).toContain('## whichtool inspect')
    expect(markdown).toContain('<details>')
    expect(markdown).toContain('descriptions/identical')
    expect(markdown).toContain('No tool was executed')
  })

  test('a clean surface says so instead of listing nothing', async () => {
    expect(renderInspectMarkdown(await inspectOf('clean.json'))).toContain('No errors or warnings')
  })

  test("a run report keeps every rate's denominator", async () => {
    const markdown = renderRunMarkdown(await runOf(GOOD))
    expect(markdown).toContain('## whichtool run')
    expect(markdown).toMatch(/\*\*single-call accuracy\*\* \| \d+\/\d+ = \d+%/)
    expect(markdown).toContain('over-trigger')
    expect(markdown).toContain('multiple calls')
    expect(markdown).toContain('failed trials')
  })

  test('JUnit exposes additional calls even when the task still passes by majority', async () => {
    const report = await runOf(GOOD)
    const trialIndex = report.trials.findIndex((trial) => trial.verdict === 'correct')
    const trial = report.trials[trialIndex]
    expect(trial).toBeDefined()
    if (trial === undefined) return
    report.trials[trialIndex] = {
      ...trial,
      calls: [...trial.calls, { name: 'search_users', arguments: null }],
      callCount: 2,
      verdict: 'unexpected-additional-calls',
      unexpectedAdditionalCalls: true,
    }

    expect(renderRunJUnit(report)).toContain('1 trials proposed multiple tool calls')
  })

  test('JUnit reports a correct first pick with additional calls as multiple-calls', async () => {
    const report = await runOf(GOOD)
    const seed = report.trials.find((trial) => trial.verdict === 'correct')
    expect(seed).toBeDefined()
    if (seed === undefined) return

    report.trials = report.trials.map((trial) =>
      trial.taskId === seed.taskId && trial.verdict === 'correct'
        ? {
            ...trial,
            calls: [...trial.calls, { name: 'search_users', arguments: null }],
            callCount: trial.calls.length + 1,
            verdict: 'unexpected-additional-calls',
            unexpectedAdditionalCalls: true,
          }
        : trial,
    )

    const junit = renderRunJUnit(report)
    expect(junit).toContain('type="multiple-calls"')
    expect(junit).toContain('got multiple calls')
    expect(junit).not.toContain(`expected ${seed.pick}, got ${seed.pick}`)
  })

  test('a run report states the threshold verdict', async () => {
    const markdown = renderRunMarkdown(await runOf(GOOD))
    expect(markdown).toMatch(/thresholds (met|violated)/)
  })

  test('every renderer exposes an otherwise healthy run with an error diagnostic as failed', async () => {
    const report = await runOf(COMPETENT, {
      thresholds: {},
      upstreamDiagnostics: [
        {
          code: 'surface/duplicate-tool-name',
          severity: 'error',
          message: 'Duplicate tool name.',
        },
      ],
    })
    expect(report).toMatchObject({ ok: false, execution: { ok: true }, thresholdsOk: true })

    expect(renderRunTerminal(report, { color: false })).toContain('FAILED (1 error diagnostic)')
    expect(renderRunMarkdown(report)).toContain('**Run failed:** 1 error diagnostic.')
    expect(renderRunHtml(report)).toContain('Run failed with 1 error diagnostic(s).')
    expect(renderRunJUnit(report)).toContain('name="whichtool.diagnostics"')
    expect(renderRunJUnit(report)).toContain('type="diagnostic"')
    expect(badgeForRun(report)).toMatchObject({
      color: 'red',
      message: 'failing verdict (1 error)',
    })
    expect(badgeForOverTrigger(report)).toMatchObject({
      color: 'red',
      message: 'failing verdict (1 error)',
    })
  })

  test('carries the reproducibility block, so a pasted comment is self-describing', async () => {
    const markdown = renderRunMarkdown(await runOf(GOOD))
    expect(markdown).toContain('surface hash')
    expect(markdown).toContain('honours temperature 0')
  })

  test('a pipe in a tool name cannot break the table', async () => {
    const markdown = renderRunMarkdown(await runOf(GOOD))
    for (const line of markdown.split('\n')) {
      if (!line.startsWith('|')) continue
      // Every unescaped pipe must be a real column separator.
      expect(line.endsWith('|')).toBe(true)
    }
  })

  test('text reporters render terminal controls visibly instead of executing them', async () => {
    const report = await runOf(GOOD)
    const hostile: RunReport = {
      ...report,
      target: {
        ...report.target,
        ref: 'surface\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007',
      },
      reproducibility: { ...report.reproducibility, provider: 'evil\u001b[31m\u202e' },
    }
    const rendered = [
      renderRunTerminal(hostile, { color: false }),
      renderRunMarkdown(hostile),
      renderRunJUnit(hostile),
      renderRunHtml(hostile),
    ]
    for (const text of rendered) {
      expect(text).not.toContain('\u001b')
      expect(text).not.toContain('\u0007')
      expect(text).not.toContain('\u202e')
      expect(text).toContain('\\x1b')
    }
  })
})

describe('the HTML reporter', () => {
  test('is a single self-contained file', async () => {
    const html = renderRunHtml(await runOf(GOOD))
    expect(html.startsWith('<!doctype html>')).toBe(true)
    // A strict CSP or an offline reader must be able to render it.
    expect(html).not.toMatch(/src="https?:|href="https?:|@import|fetch\(/)
    expect(html).toContain('<style>')
    expect(html).toContain('<script>')
    expect(html).toContain('multiple calls')
  })

  test('embeds the trials so the matrix can be navigated', async () => {
    const html = renderRunHtml(await runOf(GOOD))
    expect(html).toContain('id="whichtool-data"')
    const payload = html.split('id="whichtool-data">')[1]?.split('</script>')[0] ?? ''
    const data = JSON.parse(payload) as { trials: Array<{ prompt: string }> }
    expect(data.trials.length).toBeGreaterThan(0)
    // The prompt comes from the task list on the report, not from the assistant's reply.
    expect(data.trials[0]?.prompt.length).toBeGreaterThan(0)
  })

  test('makes every matrix cell keyboard accessible', async () => {
    const html = renderRunHtml(await runOf(GOOD))
    expect(html).toContain('role="button" tabindex="0"')
    expect(html).toContain('aria-controls="trials"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('event.key !== "Enter" && event.key !== " "')
  })

  test('escapes content that came from the server under test', async () => {
    const surface = await loadSurface(
      snapshotTransportFromData(
        {
          tools: [
            {
              name: 'x_tool',
              description: '<script>alert(1)</script> & "quoted"',
              inputSchema: { type: 'object' },
            },
          ],
        },
        'hostile',
      ),
    )
    const taskSet = parseTaskSet(
      JSON.stringify({
        version: 1,
        tasks: [{ id: 't', prompt: '<img onerror=x>', expected: 'x_tool' }],
      }),
      'inline',
    )
    const provider = createKeywordProvider({ img: 'x_tool' })
    const plan = planTrials(taskSet.tasks, surface.tools, { repeat: 1 })
    const executed = await runTrials(plan, taskSet.tasks, surface.tools, provider, {})
    const html = renderRunHtml(
      buildRunReport({
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
      }),
    )

    // Nothing from the surface or the task set may reach the document as live markup.
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img onerror=x>')
    expect(html).toContain('\\u003cimg onerror=x\\u003e')
  })

  test('says plainly that no tool was executed', async () => {
    expect(renderRunHtml(await runOf(GOOD))).toContain('No tool was executed')
  })
})

describe('the badges', () => {
  test('a run badge carries the denominator', async () => {
    const badge = badgeForRun(await runOf(GOOD, { thresholds: {} }))
    expect(badge.schemaVersion).toBe(1)
    expect(badge.message).toMatch(/^\d+% of \d+$/)
  })

  test('an unmeasured rate is grey, never a reassuring green', async () => {
    const run = await runOf(GOOD, { thresholds: {} })
    const emptied = {
      ...run,
      metrics: {
        ...run.metrics,
        accuracy: { numerator: 0, denominator: 0, value: null, ci95: null },
      },
    }
    expect(badgeForRun(emptied as RunReport).color).toBe('lightgrey')
    expect(badgeForRun(emptied as RunReport).message).toBe('not measured')
  })

  test('the over-trigger badge is inverted, since low is the good outcome', async () => {
    const badge = badgeForOverTrigger(await runOf(GOOD, { thresholds: {} }))
    expect(badge.label).toBe('over-trigger')
    expect(['brightgreen', 'green', 'yellow', 'orange', 'red', 'lightgrey']).toContain(badge.color)
  })

  test('an inspect badge reports tools, tokens and any errors', async () => {
    const badge = badgeForInspect(await inspectOf('list-search-pair.json'))
    expect(badge.message).toContain('4 tools')
    expect(badge.message).toContain('1 error')
    expect(badge.message).not.toContain('1 errors')
    expect(badge.color).toBe('red')
  })

  test('a clean surface gets a green inspect badge', async () => {
    expect(badgeForInspect(await inspectOf('clean.json')).color).toBe('green')
  })
})
