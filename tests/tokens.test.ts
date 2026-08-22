import { describe, expect, test } from 'bun:test'
import {
  countSurfaceTokens,
  countToolTokens,
  getTokenizer,
  heuristicTokenizer,
  serializeToolForCounting,
} from '../src/core/surface/tokens.js'
import { normalizeTools } from '../src/core/surface/normalize.js'
import { readFixture } from './helpers.js'
import type { RawTool } from '../src/core/types.js'

const tokenizer = heuristicTokenizer()

describe('heuristicTokenizer', () => {
  test('reports itself as an estimate, never as exact', () => {
    expect(tokenizer.info.exact).toBe(false)
    expect(getTokenizer('anthropic').info.exact).toBe(false)
    expect(getTokenizer('anthropic').info.approximates).toBe('anthropic')
  })

  test('counts nothing for the empty string', () => {
    expect(tokenizer.count('')).toBe(0)
  })

  test('is deterministic', () => {
    const text = 'Return one user by their workspace id.'
    expect(tokenizer.count(text)).toBe(tokenizer.count(text))
  })

  test('never shrinks when text is appended', () => {
    let previous = 0
    for (const text of ['a', 'a b', 'a b c', 'a b c dddddddddd']) {
      const count = tokenizer.count(text)
      expect(count).toBeGreaterThanOrEqual(previous)
      previous = count
    }
  })

  test('lands in a sane range for ordinary English prose', () => {
    // 4-ish characters per token is the usual ballpark; assert the band, not a number.
    const prose =
      'Return the invoices whose due date has passed and which are not yet settled, oldest first.'
    const count = tokenizer.count(prose)
    expect(count).toBeGreaterThan(prose.length / 8)
    expect(count).toBeLessThan(prose.length / 2)
  })
})

describe('serializeToolForCounting', () => {
  test('counts what the model reads and leaves out what the client consumes', () => {
    const { tools } = normalizeTools([
      {
        name: 't',
        description: 'd',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true, title: 'Pretty Title' },
        title: 'Pretty Title',
      },
    ])
    const serialized = serializeToolForCounting(tools[0]!)
    expect(serialized).toContain('"name":"t"')
    expect(serialized).not.toContain('readOnlyHint')
    expect(serialized).not.toContain('Pretty Title')
  })

  test('counts the wire schema, not the ref-inlined one', () => {
    const { tools } = normalizeTools([
      {
        name: 't',
        description: 'd',
        inputSchema: {
          type: 'object',
          $defs: { id: { type: 'string' } },
          properties: { a: { $ref: '#/$defs/id' }, b: { $ref: '#/$defs/id' } },
        },
      },
    ])
    expect(serializeToolForCounting(tools[0]!)).toContain('$ref')
  })
})

describe('countSurfaceTokens', () => {
  const payload = readFixture('bloated.json') as { tools: RawTool[] }
  const { tools } = normalizeTools(payload.tools)
  const counted = countSurfaceTokens(tools, tokenizer)

  test('the total is exactly the sum of the parts', () => {
    const summed = Object.values(counted.byTool).reduce((sum, entry) => sum + entry.total, 0)
    expect(counted.total).toBe(summed)
  })

  test('declares the tokenizer and the serialization it used', () => {
    expect(counted.tokenizer.id).toBe('heuristic-bpe-v1')
    expect(counted.serialization).toBe('mcp-neutral-compact')
  })

  test('attributes the bloat to the tool that carries it', () => {
    const heavy = counted.byTool['query_analytics']!
    expect(heavy.total / counted.total).toBeGreaterThan(0.8)
    expect(heavy.description).toBeGreaterThan(heavy.schema)
  })

  test('the envelope remainder is never negative', () => {
    for (const breakdown of Object.values(counted.byTool)) {
      expect(breakdown.envelope).toBeGreaterThanOrEqual(0)
    }
  })

  test('a tool with no description still costs its name and schema', () => {
    const { tools: bare } = normalizeTools([{ name: 'x', inputSchema: { type: 'object' } }])
    expect(countToolTokens(bare[0]!, tokenizer).total).toBeGreaterThan(0)
  })
})
