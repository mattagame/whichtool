import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { buildInspectReport, INSPECT_SCHEMA_VERSION, topFindings } from '../src/core/inspect.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import { createSnapshotTransport } from '../src/core/transport/index.js'
import { fixturePath } from './helpers.js'
import type { InspectOptions, InspectReport } from '../src/core/inspect.js'

const deps = { readTextFile: (path: string) => readFile(path, 'utf8') }

async function inspectFixture(name: string, options: InspectOptions = {}): Promise<InspectReport> {
  const transport = await createSnapshotTransport(fixturePath(name), deps)
  return buildInspectReport(await loadSurface(transport), options)
}

describe('buildInspectReport', () => {
  test('stays quiet on a surface with nothing wrong with it', async () => {
    const report = await inspectFixture('clean.json')
    const loud = report.diagnostics.filter((d) => d.severity !== 'info')
    expect(loud).toEqual([])
    expect(report.ok).toBe(true)
  })

  test('puts the identical descriptions at the top of the list/search surface', async () => {
    const report = await inspectFixture('list-search-pair.json')
    const worst = topFindings(report, 1)[0]
    expect(worst?.code).toBe('descriptions/identical')
    expect(worst?.tools).toEqual(['list_users', 'search_users'])
    expect(report.analysisOk).toBe(false)
    expect(report.thresholdsOk).toBe(true)
    expect(report.ok).toBe(false)
  })

  test('attributes the context cost to the tool that causes it', async () => {
    const report = await inspectFixture('bloated.json')
    const heaviest = [...report.surface.tools].sort((a, b) => b.tokens.total - a.tokens.total)[0]
    expect(heaviest?.name).toBe('query_analytics')
    expect(heaviest?.tokenShare).toBeGreaterThan(0.8)
  })

  test('a token budget that is exceeded fails the report rather than warning quietly', async () => {
    const report = await inspectFixture('bloated.json', { maxContextTokens: 100 })
    expect(report.ok).toBe(false)
    expect(report.thresholds).toEqual([
      { name: 'maxContextTokens', limit: 100, actual: report.tokens.total, ok: false },
    ])
    expect(report.diagnostics[0]?.code).toBe('threshold/maxContextTokens')
  })

  test('a token budget that is met passes', async () => {
    const report = await inspectFixture('clean.json', { maxContextTokens: 100_000 })
    expect(report.ok).toBe(true)
  })

  test('names the spec revision its deprecation check was reconciled against', async () => {
    const report = await inspectFixture('clean.json')
    expect(report.deprecations.checked).toBe(true)
    expect(report.deprecations.specRevision).toBe('2026-07-28')
    // An empty result here means "checked and found nothing", which is a different claim
    // from "not checked" and the report has to be able to say which one it is.
    expect(report.deprecations.registrySize).toBeGreaterThan(0)
    expect(report.deprecations.ruleCount).toBe(0)
    expect(report.deprecations.note).toContain('none of the')
  })

  test('reports the tools a conforming client drops for an invalid x-mcp-header', async () => {
    const report = await inspectFixture('header-params.json')
    expect(report.headerParams.rejectedTools).toEqual(['export_report', 'stream_events'])
    expect(report.diagnostics.filter((d) => d.code === 'x-mcp-header/invalid')).toHaveLength(2)
  })

  test('counts parameters from the resolved schema, so $defs do not hide them', async () => {
    const report = await inspectFixture('refs-and-defs.json')
    const order = report.surface.tools.find((tool) => tool.name === 'create_order')
    expect(order?.parameterCount).toBe(2)
    expect(order?.requiredParameterCount).toBe(1)
  })

  test('keeps the served position even though tools are reported by name', async () => {
    const report = await inspectFixture('list-search-pair.json')
    expect(report.surface.tools.map((tool) => tool.name)).toEqual([
      'count_users',
      'get_user',
      'list_users',
      'search_users',
    ])
    expect(report.surface.tools.find((tool) => tool.name === 'list_users')?.servedIndex).toBe(0)
  })

  test('orders diagnostics worst-first and deterministically', async () => {
    const report = await inspectFixture('contradictory-annotations.json')
    const severities = report.diagnostics.map((d) => d.severity)
    const rank = { error: 0, warning: 1, info: 2 } as const
    for (let index = 1; index < severities.length; index += 1) {
      expect(rank[severities[index]!]).toBeGreaterThanOrEqual(rank[severities[index - 1]!])
    }
    const again = await inspectFixture('contradictory-annotations.json')
    expect(JSON.stringify(again.diagnostics)).toBe(JSON.stringify(report.diagnostics))
  })

  test('carries the schema version and the surface hash for reproducibility', async () => {
    const report = await inspectFixture('clean.json')
    expect(report.schemaVersion).toBe(INSPECT_SCHEMA_VERSION)
    expect(report.surface.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(report.target.transport).toBe('snapshot')
  })

  test('two inspections of one surface are byte-identical, so a CI diff means something', async () => {
    const first = await inspectFixture('get-fetch-pair.json')
    const second = await inspectFixture('get-fetch-pair.json')
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
