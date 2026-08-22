import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffRuns, pairedSignPValue, parseRunReport } from '../src/core/diff.js'
import { planTrials } from '../src/core/eval/planner.js'
import { runTrials } from '../src/core/eval/runner.js'
import { scoreTrials } from '../src/core/eval/scorer.js'
import { createMockProvider } from '../src/core/providers/mock.js'
import { renderDiffMarkdown, renderDiffTerminal } from '../src/core/report/diff-terminal.js'
import { buildRunReport, type RunReport, type RunThresholds } from '../src/core/run.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import { parseTaskSet } from '../src/core/tasks/load.js'
import { snapshotTransportFromData } from '../src/core/transport/index.js'
import { readFixture, REPO_ROOT } from './helpers.js'

const TASKS_FILE = join(REPO_ROOT, 'tests', 'fixtures', 'tasks', 'list-search.tasks.yaml')

type MutableObject = Record<string, unknown>

interface MutableRunWire extends MutableObject {
  schemaVersion: string
  reproducibility: MutableObject & {
    repeat: number
    providerCapabilities: MutableObject
  }
  target: MutableObject
  tasks: MutableObject & { list: MutableObject[] }
  contextCost: MutableObject & {
    total: number
    tokenizer: MutableObject
    byTool: Record<string, MutableObject & { total: number }>
  }
  diagnostics: MutableObject[]
  thresholds: Array<MutableObject & { name: string; limit: number; actual: number; ok: boolean }>
  execution?: MutableObject & { planned: number; errorRate: MutableObject }
  thresholdsOk?: boolean
  ok: boolean
  metrics: MutableObject & {
    accuracy: MutableObject & { numerator: number; value: number | null }
    byTool: MutableObject[]
    multiCallRate?: unknown
  }
  trials: Array<Record<string, unknown> & { callCount: number }>
}

function mutableWire(report: RunReport): MutableRunWire {
  return JSON.parse(JSON.stringify(report)) as MutableRunWire
}

/** Build a run whose picks are decided by the keyword map, so the outcome is chosen. */
async function makeRun(
  rules: Record<string, string | readonly string[]>,
  overrides: {
    repeat?: number
    temperature?: number
    model?: string
    permute?: boolean
    thresholds?: RunThresholds
  } = {},
): Promise<RunReport> {
  const surface = await loadSurface(
    snapshotTransportFromData(readFixture('list-search-pair.json'), 'list-search-pair.json'),
  )
  const taskSet = parseTaskSet(readFileSync(TASKS_FILE, 'utf8'), 'list-search.tasks.yaml')
  const provider = createMockProvider({
    model: overrides.model ?? 'mock-1',
    script: (request) => {
      const prompt = request.prompt.toLowerCase()
      for (const [keyword, configured] of Object.entries(rules)) {
        if (!prompt.includes(keyword.toLowerCase())) continue
        const picks = typeof configured === 'string' ? [configured] : configured
        return {
          pick: picks[0] ?? null,
          calls: picks.map((name) => ({ name, arguments: null })),
        }
      }
      return { pick: null, text: 'I cannot help with that.' }
    },
  })
  const plan = planTrials(taskSet.tasks, surface.tools, {
    repeat: overrides.repeat ?? 4,
    seed: 7,
    permute: overrides.permute ?? true,
  })
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
    temperature: overrides.temperature ?? 0,
    concurrency: 4,
    thresholds: overrides.thresholds,
  })
}

const GOOD = {
  roster: 'list_users',
  'all the users': 'list_users',
  'next page': 'list_users',
  contains: 'search_users',
  matching: 'search_users',
  'look up': 'get_user',
  'how many': 'count_users',
}

describe('pairedSignPValue', () => {
  test('requires paired evidence, not a raw count', () => {
    expect(pairedSignPValue(0, 1)).toBe(1)
    expect(pairedSignPValue(0, 8)).toBeLessThan(0.05)
    expect(pairedSignPValue(4, 4)).toBe(1)
  })
})

describe('parseRunReport', () => {
  test('refuses a payload that is not a run report', () => {
    expect(() => parseRunReport({ hello: true }, 'x.json')).toThrow(/schema/)
  })

  test('refuses a schema version this build does not read', () => {
    expect(() => parseRunReport({ schemaVersion: 'whichtool.run/99' }, 'x.json')).toThrow(
      /this build reads/,
    )
  })

  test('validates the run/2 invariants instead of trusting a version string', async () => {
    const report = await makeRun(GOOD, { repeat: 1 })
    expect(parseRunReport(JSON.parse(JSON.stringify(report)), 'valid.json')).toEqual(report)

    const missingCalls = mutableWire(report)
    const missingFirst = missingCalls.trials[0]
    if (missingFirst === undefined) throw new Error('fixture produced no trials')
    delete missingFirst.calls
    expect(() => parseRunReport(missingCalls, 'missing-calls.json')).toThrow(/calls.*required/)

    const wrongCount = mutableWire(report)
    const wrongFirst = wrongCount.trials[0]
    if (wrongFirst === undefined) throw new Error('fixture produced no trials')
    wrongFirst.callCount += 1
    expect(() => parseRunReport(wrongCount, 'wrong-count.json')).toThrow(/calls\.length/)

    const forgedMetric = mutableWire(report)
    forgedMetric.metrics.accuracy.numerator = 0
    forgedMetric.metrics.accuracy.value = 0
    expect(() => parseRunReport(forgedMetric, 'forged.json')).toThrow(/recorded trials/)

    const falseHeadline = mutableWire(report)
    falseHeadline.ok = !falseHeadline.ok
    expect(() => parseRunReport(falseHeadline, 'headline.json')).toThrow(/execution\.ok/)

    const hiddenError = mutableWire(report)
    hiddenError.diagnostics.push({
      code: 'forged/error',
      severity: 'error',
      message: 'This diagnostic must fail the headline.',
    })
    hiddenError.ok = true
    expect(() => parseRunReport(hiddenError, 'diagnostic-headline.json')).toThrow(
      /no error diagnostics/,
    )
  })

  test('rejects unknown properties from every fixed-shape report layer', async () => {
    const report = await makeRun(GOOD, {
      repeat: 1,
      thresholds: { minAccuracy: 0.5 },
    })
    const cases: Array<[string, (wire: MutableRunWire) => void]> = [
      ['root', (wire) => (wire['extra'] = true)],
      ['reproducibility', (wire) => (wire.reproducibility['extra'] = true)],
      [
        'provider capabilities',
        (wire) => (wire.reproducibility.providerCapabilities['extra'] = true),
      ],
      ['target', (wire) => (wire.target['extra'] = true)],
      ['task selection', (wire) => (wire.tasks['extra'] = true)],
      ['task', (wire) => (wire.tasks.list[0]!['extra'] = true)],
      ['context', (wire) => (wire.contextCost['extra'] = true)],
      ['tokenizer', (wire) => (wire.contextCost.tokenizer['extra'] = true)],
      [
        'token breakdown',
        (wire) => {
          const breakdown = Object.values(wire.contextCost.byTool)[0]
          if (breakdown === undefined) throw new Error('fixture produced no token breakdown')
          breakdown['extra'] = true
        },
      ],
      ['diagnostic', (wire) => (wire.diagnostics[0]!['extra'] = true)],
      ['threshold', (wire) => (wire.thresholds[0]!['extra'] = true)],
      ['metrics', (wire) => (wire.metrics['extra'] = true)],
      ['nested metric', (wire) => (wire.metrics.accuracy['extra'] = undefined)],
      ['tool metrics', (wire) => (wire.metrics.byTool[0]!['extra'] = true)],
      ['trial', (wire) => (wire.trials[0]!['extra'] = true)],
      [
        'recorded call',
        (wire) => {
          const trial = wire.trials.find(
            (candidate) => Array.isArray(candidate['calls']) && candidate['calls'].length > 0,
          )
          const call = (trial?.['calls'] as MutableObject[] | undefined)?.[0]
          if (call === undefined) throw new Error('fixture produced no recorded call')
          call['extra'] = true
        },
      ],
      [
        'usage',
        (wire) => {
          wire.trials[0]!['usage'] = { extra: true }
        },
      ],
      [
        'argument check',
        (wire) => {
          wire.trials[0]!['argumentCheck'] = {
            missingRequired: [],
            hallucinated: [],
            wrongType: [],
            parsed: false,
            vacuous: true,
            extra: true,
          }
        },
      ],
      [
        'error',
        (wire) => {
          wire.trials[0]!['error'] = {
            message: 'forged',
            retryable: false,
            extra: true,
          }
        },
      ],
      ['execution', (wire) => (wire.execution!['extra'] = true)],
      ['proportion', (wire) => (wire.execution!.errorRate['extra'] = true)],
    ]

    for (const [label, mutate] of cases) {
      const wire = mutableWire(report)
      mutate(wire)
      expect(() => parseRunReport(wire, `${label}.json`)).toThrow(/not allowed/)
    }
  })

  test('recomputes thresholds, trial coverage, and context-cost arithmetic', async () => {
    const report = await makeRun(GOOD, {
      repeat: 1,
      thresholds: { minAccuracy: 0.9, maxContextTokens: 10_000 },
    })

    const forgedActual = mutableWire(report)
    const accuracy = forgedActual.thresholds.find((threshold) => threshold.name === 'minAccuracy')
    if (accuracy === undefined) throw new Error('fixture produced no accuracy threshold')
    accuracy.actual = accuracy.actual === 0 ? 1 : 0
    expect(() => parseRunReport(forgedActual, 'threshold-actual.json')).toThrow(
      /measured report value/,
    )

    const forgedThresholdVerdict = mutableWire(report)
    const verdict = forgedThresholdVerdict.thresholds.find(
      (threshold) => threshold.name === 'minAccuracy',
    )
    if (verdict === undefined) throw new Error('fixture produced no accuracy threshold')
    verdict.ok = !verdict.ok
    expect(() => parseRunReport(forgedThresholdVerdict, 'threshold-ok.json')).toThrow(
      /limit and measured value/,
    )

    const forgedRepeat = mutableWire(report)
    forgedRepeat.reproducibility.repeat += 1
    expect(() => parseRunReport(forgedRepeat, 'repeat.json')).toThrow(
      /tasks\.selected.*reproducibility\.repeat/,
    )

    const outOfRangeOptions = mutableWire(report)
    outOfRangeOptions.reproducibility['temperature'] = 3
    expect(() => parseRunReport(outOfRangeOptions, 'temperature.json')).toThrow(/at most 2/)

    const excessiveConcurrency = mutableWire(report)
    excessiveConcurrency.reproducibility['concurrency'] = 65
    expect(() => parseRunReport(excessiveConcurrency, 'concurrency.json')).toThrow(/at most 64/)

    const forgedOrder = mutableWire(report)
    forgedOrder.trials[0]!['order'] = []
    expect(() => parseRunReport(forgedOrder, 'order.json')).toThrow(/permutation/)

    const forgedPosition = mutableWire(report)
    const firstTrial = forgedPosition.trials[0]
    if (firstTrial === undefined) throw new Error('fixture produced no trial')
    firstTrial['expectedPosition'] = Number(firstTrial['expectedPosition']) + 1
    expect(() => parseRunReport(forgedPosition, 'position.json')).toThrow(
      /expected tool index in order/,
    )

    const forgedError = mutableWire(report)
    const calledTrial = forgedError.trials.find(
      (trial) => Array.isArray(trial['calls']) && trial['calls'].length > 0,
    )
    if (calledTrial === undefined) throw new Error('fixture produced no called trial')
    calledTrial['error'] = { message: 'forged failure', retryable: false }
    calledTrial['verdict'] = 'error'
    expect(() => parseRunReport(forgedError, 'error-shape.json')).toThrow(
      /must carry no calls, text, latency, or clarification/,
    )

    const forgedContextTotal = mutableWire(report)
    forgedContextTotal.contextCost.total += 1
    expect(() => parseRunReport(forgedContextTotal, 'context-total.json')).toThrow(
      /sum of contextCost\.byTool totals/,
    )

    const forgedBreakdown = mutableWire(report)
    const breakdown = Object.values(forgedBreakdown.contextCost.byTool)[0]
    if (breakdown === undefined) throw new Error('fixture produced no token breakdown')
    breakdown.total += 1
    forgedBreakdown.contextCost.total += 1
    expect(() => parseRunReport(forgedBreakdown, 'breakdown.json')).toThrow(
      /name \+ description \+ schema \+ envelope/,
    )

    const forgedNames = mutableWire(report)
    const first = Object.entries(forgedNames.contextCost.byTool)[0]
    if (first === undefined) throw new Error('fixture produced no token breakdown')
    delete forgedNames.contextCost.byTool[first[0]]
    forgedNames.contextCost.byTool[`${first[0]}-forged`] = first[1]
    expect(() => parseRunReport(forgedNames, 'context-names.json')).toThrow(
      /exactly the tools in metrics\.byTool/,
    )
  })

  test('migrates the legacy single-call report to a validated run/2 report', async () => {
    const modern = await makeRun(GOOD, { repeat: 1 })
    const legacy = mutableWire(modern)
    legacy.schemaVersion = 'whichtool.run/1'
    delete legacy.execution
    delete legacy.thresholdsOk
    delete legacy.metrics.multiCallRate
    for (const trial of legacy.trials) {
      delete trial.calls
      delete trial.unexpectedAdditionalCalls
    }

    const migrated = parseRunReport(legacy, 'legacy.json')
    expect(migrated.schemaVersion).toBe('whichtool.run/2')
    expect(migrated.trials.every((trial) => trial.callCount === trial.calls.length)).toBe(true)
    expect(migrated.metrics.multiCallRate.denominator).toBe(migrated.metrics.trials.scored)
    expect(migrated.ok).toBe(
      migrated.execution.ok &&
        migrated.thresholdsOk &&
        !migrated.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    )

    const legacyWithError = mutableWire(modern)
    legacyWithError.schemaVersion = 'whichtool.run/1'
    delete legacyWithError.execution
    delete legacyWithError.thresholdsOk
    delete legacyWithError.metrics.multiCallRate
    legacyWithError.diagnostics.push({
      code: 'legacy/error',
      severity: 'error',
      message: 'Legacy migration must preserve this gate.',
    })
    for (const trial of legacyWithError.trials) {
      delete trial.calls
      delete trial.unexpectedAdditionalCalls
    }
    expect(parseRunReport(legacyWithError, 'legacy-error.json').ok).toBe(false)
  })
})

describe('diffRuns', () => {
  test('a run against itself shows no change and notes the identical surface', async () => {
    const run = await makeRun(GOOD)
    const diff = diffRuns(run, run)
    expect(diff.comparable).toBe(true)
    expect(diff.accuracy.delta).toBe(0)
    expect(diff.ok).toBe(true)
    expect(diff.diagnostics.map((d) => d.code)).toContain('diff/same-surface')
  })

  test('a real regression is reported with its size', async () => {
    const base = await makeRun(GOOD)
    const head = await makeRun({ ...GOOD, contains: 'list_users', matching: 'list_users' })
    const diff = diffRuns(base, head)

    expect(diff.accuracy.delta).toBeLessThan(0)
    const searchUsers = diff.byTool.find((tool) => tool.tool === 'search_users')
    expect(searchUsers?.delta).toBeLessThan(0)
  })

  test('a confusion pair that appears is an error, and one that goes away is noted', async () => {
    const broken = await makeRun({ ...GOOD, contains: 'list_users', matching: 'list_users' })
    const fixed = await makeRun(GOOD)

    const regressing = diffRuns(fixed, broken)
    expect(regressing.newConfusions).toHaveLength(1)
    expect(regressing.newConfusions[0]?.tools).toEqual(['list_users', 'search_users'])
    expect(regressing.ok).toBe(false)
    expect(regressing.diagnostics.some((d) => d.code === 'diff/new-confusion')).toBe(true)

    const improving = diffRuns(broken, fixed)
    expect(improving.resolvedConfusions).toHaveLength(1)
    expect(improving.newConfusions).toHaveLength(0)
    expect(improving.ok).toBe(true)
  })

  test('refuses to subtract runs that measured different things', async () => {
    const base = await makeRun(GOOD, { model: 'model-a' })
    const head = await makeRun(GOOD, { model: 'model-b' })
    const diff = diffRuns(base, head)

    expect(diff.comparable).toBe(false)
    expect(diff.incomparable[0]).toContain('different model')
    expect(diff.ok).toBe(false)
  })

  for (const [label, overrides] of [
    ['temperature', { temperature: 0.7 }],
    ['repeat count', { repeat: 2 }],
    ['permutation setting', { permute: false }],
  ] as const) {
    test(`a different ${label} makes the runs incomparable`, async () => {
      const diff = diffRuns(await makeRun(GOOD), await makeRun(GOOD, overrides))
      expect(diff.comparable).toBe(false)
    })
  }

  test('different endpoints or seeds make runs incomparable', async () => {
    const base = await makeRun(GOOD)
    const endpoint = {
      ...base,
      reproducibility: { ...base.reproducibility, endpoint: 'https://other.test/v1' },
    }
    const seed = {
      ...base,
      reproducibility: { ...base.reproducibility, seed: base.reproducibility.seed + 1 },
    }
    expect(diffRuns(base, endpoint).comparable).toBe(false)
    expect(diffRuns(base, seed).comparable).toBe(false)
  })

  test('different provider request construction makes runs incomparable', async () => {
    const base = await makeRun(GOOD)
    const changed = {
      ...base,
      reproducibility: { ...base.reproducibility, requestFingerprint: 'sha256:changed' },
    }
    const diff = diffRuns(base, changed)
    expect(diff.comparable).toBe(false)
    expect(diff.incomparable.join(' ')).toContain('request construction')
  })

  test('refuses to attribute a changed question to the surface', async () => {
    const base = await makeRun(GOOD)
    const changed = {
      ...base,
      tasks: {
        ...base.tasks,
        list: base.tasks.list.map((task, index) =>
          index === 0 ? { ...task, prompt: `${task.prompt} please` } : task,
        ),
      },
    }
    const diff = diffRuns(base, changed)
    expect(diff.comparable).toBe(false)
    expect(diff.incomparable).toContain('different selected tasks, prompts or expected tools.')
  })

  test('a change too small to distinguish is labelled inconclusive rather than reported', async () => {
    const base = await makeRun(GOOD, { repeat: 2 })
    const head = await makeRun({ ...GOOD, 'how many': 'list_users' }, { repeat: 2 })
    const diff = diffRuns(base, head)

    expect(diff.accuracy.delta).toBeLessThan(0)
    expect(diff.accuracy.distinguishable).toBe(false)
    expect(diff.diagnostics.map((d) => d.code)).toContain('diff/inconclusive')
  })

  test('--max-accuracy-drop does not fire on an inconclusive paired drop', async () => {
    const base = await makeRun(GOOD, { repeat: 2 })
    const head = await makeRun({ ...GOOD, 'how many': 'list_users' }, { repeat: 2 })
    // The point estimate drops, but too few paired trials changed to support a gate.
    const diff = diffRuns(base, head, { maxAccuracyDrop: 0.01 })
    expect(diff.diagnostics.map((d) => d.code)).not.toContain('threshold/maxAccuracyDrop')
  })

  test('a single new swap is a warning, not a failed gate', async () => {
    // One repeat means the one changed task swaps exactly once.
    const base = await makeRun(GOOD, { repeat: 1 })
    const head = await makeRun({ ...GOOD, 'how many': 'list_users' }, { repeat: 1 })
    const diff = diffRuns(base, head)

    expect(diff.newConfusions).toHaveLength(1)
    expect(diff.newConfusions[0]?.swaps).toBe(1)
    const finding = diff.diagnostics.find((d) => d.code === 'diff/new-confusion')
    expect(finding?.severity).toBe('warning')
    expect(finding?.message).toContain('inconclusive')
    expect(diff.ok).toBe(true)
  })

  test('a distinguishable multi-call increase fails even when the first picks do not change', async () => {
    const alreadyWrong = { ...GOOD, contains: 'list_users', matching: 'list_users' }
    const withExtraCalls: Record<string, string | readonly string[]> = {
      ...alreadyWrong,
      contains: ['list_users', 'count_users'],
      matching: ['list_users', 'count_users'],
    }
    const diff = diffRuns(
      await makeRun(alreadyWrong, { repeat: 20 }),
      await makeRun(withExtraCalls, { repeat: 20 }),
    )

    expect(diff.accuracy.delta).toBe(0)
    expect(diff.multiCall.delta).toBeGreaterThan(0)
    expect(diff.multiCall.distinguishable).toBe(true)
    expect(diff.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'diff/multi-call-regressed',
    )
    expect(diff.ok).toBe(false)
  })

  test('a repeated new swap is a pattern and does fail the gate', async () => {
    const base = await makeRun(GOOD, { repeat: 4 })
    const head = await makeRun(
      { ...GOOD, contains: 'list_users', matching: 'list_users' },
      { repeat: 4 },
    )
    const diff = diffRuns(base, head)

    const finding = diff.diagnostics.find((d) => d.code === 'diff/new-confusion')
    expect(finding?.severity).toBe('error')
    expect(diff.ok).toBe(false)
  })

  test('reports the context-cost delta', async () => {
    const diff = diffRuns(await makeRun(GOOD), await makeRun(GOOD))
    expect(diff.contextTokens.delta).toBe(0)
    expect(diff.contextTokens.before).toBeGreaterThan(0)
  })
})

describe('the diff reporters', () => {
  test('the terminal output names inconclusive evidence and stays ASCII', async () => {
    const diff = diffRuns(await makeRun(GOOD, { repeat: 2 }), await makeRun(GOOD, { repeat: 2 }))
    const rendered = renderDiffTerminal(diff, { color: false, width: 88 })
    expect(rendered).toContain('whichtool diff')
    expect(rendered).toContain('inconclusive')
    expect([...new Set(rendered.match(/[^\u0000-\u007F]/g) ?? [])]).toEqual([])
  })

  /**
   * The summary rows point in opposite directions: accuracy falling is bad, over-trigger
   * falling is good. Nothing else covers this, because the golden files render with colour
   * off, where the styler is the identity and a wrong colour is invisible.
   */
  test('a fall in over-trigger reads green and a fall in accuracy reads red', async () => {
    const GREEN = '\u001B[32m'
    const RED = '\u001B[31m'
    const rowOf = (rendered: string, label: string): string | undefined =>
      rendered.split('\n').find((row) => row.includes(label))

    // The base fires a tool at a distractor; the head refuses it. Over-trigger falls.
    const improved = renderDiffTerminal(
      diffRuns(
        await makeRun({ ...GOOD, delete: 'list_users' }, { repeat: 20 }),
        await makeRun(GOOD, { repeat: 20 }),
      ),
      { color: true, width: 88 },
    )
    expect(rowOf(improved, 'over-trigger')).toContain(GREEN)

    // The head gets two tasks wrong that the base got right. Accuracy falls.
    const regressed = renderDiffTerminal(
      diffRuns(
        await makeRun(GOOD, { repeat: 20 }),
        await makeRun({ ...GOOD, contains: 'list_users', matching: 'list_users' }, { repeat: 20 }),
      ),
      { color: true, width: 88 },
    )
    expect(rowOf(regressed, 'single-call')).toContain(RED)
  })

  test('the markdown output leads with the verdict and keeps denominators', async () => {
    const base = await makeRun(GOOD)
    const head = await makeRun({ ...GOOD, contains: 'list_users', matching: 'list_users' })
    const markdown = renderDiffMarkdown(diffRuns(base, head))

    expect(markdown).toContain('## whichtool diff')
    expect(markdown).toContain('Regression detected')
    expect(markdown).toMatch(/\d+\/\d+/)
    expect(markdown).toContain('New confusion')
  })

  test('incomparable runs produce a short refusal, not a table of deltas', async () => {
    const diff = diffRuns(await makeRun(GOOD, { model: 'a' }), await makeRun(GOOD, { model: 'b' }))
    const markdown = renderDiffMarkdown(diff)
    expect(markdown).toContain('not comparable')
    expect(markdown).not.toContain('| **single-call accuracy** |')
  })

  test('incomparable runs end without a regression verdict either way', async () => {
    const diff = diffRuns(await makeRun(GOOD, { model: 'a' }), await makeRun(GOOD, { model: 'b' }))
    const terminal = renderDiffTerminal(diff, { color: false, width: 100 })
    expect(terminal).toContain('No verdict: the runs are not comparable.')
    expect(terminal).not.toContain('Regression detected.')
  })
})
