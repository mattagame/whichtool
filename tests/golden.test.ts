import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildInspectReport } from '../src/core/inspect.js'
import { planTrials } from '../src/core/eval/planner.js'
import { runTrials } from '../src/core/eval/runner.js'
import { scoreTrials } from '../src/core/eval/scorer.js'
import { createKeywordProvider } from '../src/core/providers/mock.js'
import { renderInspect } from '../src/cli/render.js'
import { renderInspectTerminal } from '../src/core/report/terminal.js'
import { renderRunTerminal } from '../src/core/report/run-terminal.js'
import { buildRunReport } from '../src/core/run.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import { parseTaskSet } from '../src/core/tasks/load.js'
import { snapshotTransportFromData } from '../src/core/transport/index.js'
import { readFixture, REPO_ROOT } from './helpers.js'

/**
 * Golden-file tests for the reporters (SPEC §10). Changing an output is then a visible
 * diff in review rather than something that slips through.
 *
 * Regenerate with `UPDATE_GOLDEN=1 bun test tests/golden.test.ts`, then read the diff.
 */
const GOLDEN_DIR = join(REPO_ROOT, 'tests', 'golden')
const UPDATE = process.env['UPDATE_GOLDEN'] === '1'

const CASES = [
  'clean.json',
  'list-search-pair.json',
  'get-fetch-pair.json',
  'no-annotations.json',
  'contradictory-annotations.json',
  'refs-and-defs.json',
  'header-params.json',
  'malformed.json',
] as const

async function renderBoth(fixture: string): Promise<{ terminal: string; json: string }> {
  // The fixture name is used as the transport ref so the golden output carries no
  // machine-specific absolute path.
  const transport = snapshotTransportFromData(readFixture(fixture), fixture)
  const report = buildInspectReport(await loadSurface(transport))
  return {
    terminal: `${renderInspectTerminal(report, { color: false, width: 88 })}\n`,
    json: renderInspect(report, 'json', { color: false, width: 88 }),
  }
}

function compare(name: string, actual: string): void {
  const path = join(GOLDEN_DIR, name)
  if (UPDATE || !existsSync(path)) {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(path, actual, 'utf8')
    return
  }
  expect(actual).toBe(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))
}

describe('reporter golden files', () => {
  for (const fixture of CASES) {
    const base = fixture.replace(/\.json$/, '')
    test(`${base} renders the expected terminal report`, async () => {
      compare(`${base}.terminal.txt`, (await renderBoth(fixture)).terminal)
    })
    test(`${base} renders the expected JSON report`, async () => {
      compare(`${base}.report.json`, (await renderBoth(fixture)).json)
    })
  }

  test('the terminal reporter emits no escape codes when colour is off', async () => {
    const { terminal } = await renderBoth('clean.json')
    expect(terminal).not.toMatch(/\[[0-9;]*m/)
  })

  test('the terminal reporter stays pure ASCII', async () => {
    // The reporter has to survive a Windows console on a legacy code page and a CI log
    // with an unhelpful encoding. A stray em dash in a diagnostic message turns into
    // mojibake in exactly the screenshot someone was about to post.
    for (const fixture of CASES) {
      const { terminal } = await renderBoth(fixture)
      const offenders = [...new Set(terminal.match(/[^\u0000-\u007F]/g) ?? [])]
      expect({ fixture, offenders }).toEqual({ fixture, offenders: [] })
    }
  })

  test('the JSON report round-trips', async () => {
    const { json } = await renderBoth('contradictory-annotations.json')
    expect(() => JSON.parse(json)).not.toThrow()
  })
})

/**
 * The run reporter, pinned the same way.
 *
 * A run is deterministic when the provider is: the mock picks by keyword, the planner is
 * seeded, and the only varying field is wall-clock time, which is zeroed below.
 */
describe('run reporter golden file', () => {
  async function renderRun(): Promise<{ terminal: string; json: string }> {
    const surface = await loadSurface(
      snapshotTransportFromData(readFixture('list-search-pair.json'), 'list-search-pair.json'),
    )
    const taskSet = parseTaskSet(
      readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'tasks', 'list-search.tasks.yaml'), 'utf8'),
      'list-search.tasks.yaml',
    )
    // A model that is good at the obvious cases, confuses list with search, and
    // over-triggers on one distractor. Enough to exercise every section of the report.
    const provider = createKeywordProvider({
      roster: 'list_users',
      'all the users': 'search_users',
      'next page': 'list_users',
      contains: 'search_users',
      matching: 'list_users',
      'look up': 'get_user',
      'how many': 'count_users',
      invite: 'list_users',
    })
    const plan = planTrials(taskSet.tasks, surface.tools, { repeat: 3, seed: 42 })
    const executed = await runTrials(plan, taskSet.tasks, surface.tools, provider, {
      concurrency: 4,
    })
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
      concurrency: 4,
      thresholds: { minAccuracy: 0.9, maxOverTrigger: 0.05 },
    })
    return {
      terminal: `${renderRunTerminal(report, { color: false, width: 88 })}\n`,
      json: `${JSON.stringify(report, null, 2)}\n`,
    }
  }

  test('renders the expected terminal report', async () => {
    compare('run.terminal.txt', (await renderRun()).terminal)
  })

  test('renders the expected JSON report', async () => {
    compare('run.report.json', (await renderRun()).json)
  })

  test('is deterministic across two identical runs', async () => {
    const [a, b] = [await renderRun(), await renderRun()]
    expect(a.terminal).toBe(b.terminal)
    expect(a.json).toBe(b.json)
  })
})
