import { describe, expect, test } from 'bun:test'
import { analyzeOverlap, diceSimilarity, HIGH_OVERLAP } from '../src/core/static/overlap.js'
import { normalizeTools } from '../src/core/surface/normalize.js'
import { readFixture } from './helpers.js'
import type { RawTool } from '../src/core/types.js'

function analyzeFixture(name: string) {
  const payload = readFixture(name) as { tools: RawTool[] }
  return analyzeOverlap(normalizeTools(payload.tools).tools)
}

describe('diceSimilarity', () => {
  test('identical text scores 1', () => {
    expect(diceSimilarity('list the users', 'list the users')).toBe(1)
  })

  test('unrelated text scores near 0', () => {
    expect(diceSimilarity('list the users', 'refund a payment')).toBeLessThan(0.2)
  })

  test('is symmetric', () => {
    expect(diceSimilarity('alpha beta', 'beta gamma')).toBe(
      diceSimilarity('beta gamma', 'alpha beta'),
    )
  })
})

describe('analyzeOverlap', () => {
  test('reports how many pairs it scored, so the list has a denominator', () => {
    const analysis = analyzeFixture('clean.json')
    expect(analysis.pairsConsidered).toBe(6) // 4 tools -> 4*3/2
  })

  test('a clean surface has no pair above the high-overlap line', () => {
    const analysis = analyzeFixture('clean.json')
    expect(analysis.pairs.every((pair) => pair.score < HIGH_OVERLAP)).toBe(true)
    expect(analysis.diagnostics.filter((d) => d.severity !== 'info')).toEqual([])
  })

  test('byte-identical descriptions are an error, not a warning', () => {
    const analysis = analyzeFixture('copied-descriptions.json')
    const identical = analysis.diagnostics.filter((d) => d.code === 'descriptions/identical')
    expect(identical).toHaveLength(3) // every pair of the three tools
    expect(identical.every((d) => d.severity === 'error')).toBe(true)
  })

  test('the list/search pair tops the ranking', () => {
    const analysis = analyzeFixture('list-search-pair.json')
    expect(analysis.pairs[0]?.tools).toEqual(['list_users', 'search_users'])
    expect(analysis.pairs[0]?.identicalDescription).toBe(true)
  })

  test('get/fetch/read all collide with each other', () => {
    const analysis = analyzeFixture('get-fetch-pair.json')
    expect(analysis.pairsConsidered).toBe(3)
    expect(analysis.pairs.every((pair) => pair.score >= HIGH_OVERLAP)).toBe(true)
  })

  test('inconsistent prefixes are invisible to a lexical metric, which is the point', () => {
    const analysis = analyzeFixture('inconsistent-prefixes.json')
    expect(analysis.diagnostics.filter((d) => d.code === 'overlap/high')).toEqual([])
  })

  test('shared terms are ranked by how rare they are on this surface', () => {
    const analysis = analyzeFixture('list-search-pair.json')
    const top = analysis.pairs[0]!
    expect(top.distinctiveSharedTerms.length).toBeGreaterThan(0)
    // "users" appears in every tool here, so it must not lead the shared-term list.
    expect(top.distinctiveSharedTerms[0]).not.toBe('users')
  })

  test('a missing description is flagged on its own', () => {
    const { tools } = normalizeTools([
      { name: 'get_a', inputSchema: {} },
      {
        name: 'get_b',
        description: 'A description long enough to pass the length check.',
        inputSchema: {},
      },
    ])
    const analysis = analyzeOverlap(tools)
    const missing = analysis.diagnostics.filter((d) => d.code === 'descriptions/missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.tool).toBe('get_a')
  })
})
