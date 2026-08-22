import { describe, expect, test } from 'bun:test'
import { analyzeAnnotations, classifyName, nameTokens } from '../src/core/static/annotations.js'
import { normalizeTools } from '../src/core/surface/normalize.js'
import { readFixture } from './helpers.js'
import type { RawTool } from '../src/core/types.js'

function analyzeFixture(name: string) {
  const payload = readFixture(name) as { tools: RawTool[] }
  return analyzeAnnotations(normalizeTools(payload.tools).tools)
}

function codes(name: string): string[] {
  return analyzeFixture(name)
    .diagnostics.map((diagnostic) => diagnostic.code)
    .sort()
}

describe('nameTokens', () => {
  test('splits snake_case, kebab-case, dots and camelCase alike', () => {
    expect(nameTokens('list_users')).toEqual(['list', 'users'])
    expect(nameTokens('folder-get')).toEqual(['folder', 'get'])
    expect(nameTokens('Search.In.Documents')).toEqual(['search', 'in', 'documents'])
    expect(nameTokens('listFolders')).toEqual(['list', 'folders'])
    expect(nameTokens('getHTTPStatus')).toEqual(['get', 'http', 'status'])
  })
})

describe('classifyName', () => {
  test('the leading verb decides, because position is what separates the two cases', () => {
    expect(classifyName('list_deleted_users').semantics).toBe('read')
    expect(classifyName('delete_user_list').semantics).toBe('destructive')
  })

  test('classifies reads, writes and destructive writes', () => {
    expect(classifyName('get_invoice').semantics).toBe('read')
    expect(classifyName('create_branch').semantics).toBe('mutate')
    expect(classifyName('purge_audit_log').semantics).toBe('destructive')
  })

  test('says it does not know rather than guessing', () => {
    expect(classifyName('weather').semantics).toBe('unknown')
  })
})

describe('analyzeAnnotations', () => {
  test('a well-annotated surface produces nothing at all', () => {
    expect(codes('clean.json')).toEqual([])
  })

  test('catches every contradiction in the contradictory fixture', () => {
    expect(codes('contradictory-annotations.json')).toEqual([
      'annotations/contradictory-read-only-destructive',
      'annotations/destructive-name-declared-safe',
      'annotations/read-only-with-mutating-name',
      'annotations/read-only-with-mutating-name',
      'annotations/unknown-key',
      'annotations/write-hint-with-read-name',
    ])
  })

  test('an unannotated surface gets one surface-wide finding, not one per tool', () => {
    const analysis = analyzeFixture('no-annotations.json')
    expect(analysis.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'annotations/absent-surface-wide',
    ])
    expect(analysis.diagnostics[0]?.tools).toHaveLength(4)
    expect(analysis.coverage.annotated).toBe(0)
  })

  test('partial coverage is called out, because inconsistency is worse than uniform absence', () => {
    const { tools } = normalizeTools([
      { name: 'get_a', description: 'd', inputSchema: {}, annotations: { readOnlyHint: true } },
      { name: 'get_b', description: 'd', inputSchema: {} },
    ])
    const analysis = analyzeAnnotations(tools)
    const partial = analysis.diagnostics.find((d) => d.code === 'annotations/partial-coverage')
    expect(partial?.severity).toBe('warning')
    expect(partial?.tools).toEqual(['get_b'])
  })

  test('a non-boolean hint is reported and does not count as coverage', () => {
    const { tools } = normalizeTools([
      { name: 'get_a', description: 'd', inputSchema: {}, annotations: { readOnlyHint: 'yes' } },
    ])
    const analysis = analyzeAnnotations(tools)
    expect(tools[0]?.annotations?.readOnlyHint).toBe('yes')
    expect(analysis.diagnostics.some((d) => d.code === 'annotations/non-boolean-hint')).toBe(true)
    expect(analysis.coverage.annotated).toBe(0)
  })

  test('states that it checks consistency and not truthfulness', () => {
    expect(analyzeFixture('clean.json').caveat).toContain('not guarantees')
  })
})
