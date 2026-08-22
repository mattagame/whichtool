import { describe, expect, test } from 'bun:test'
import {
  canonicalizeSchema,
  normalizeDescription,
  normalizeTools,
  resolveInternalRefs,
} from '../src/core/surface/normalize.js'
import { canonicalJson } from '../src/core/json.js'
import { readFixture } from './helpers.js'
import type { RawTool } from '../src/core/types.js'

describe('normalizeDescription', () => {
  test('normalises line endings, trailing spaces and blank-line runs', () => {
    expect(normalizeDescription('  a  \r\n  b   \r\n\r\n\r\n\r\nc  ')).toBe('a\n  b\n\nc')
  })

  test('keeps interior runs of spaces, because indentation is meaningful and costs tokens', () => {
    expect(normalizeDescription('- item\n    - nested')).toBe('- item\n    - nested')
  })

  test('is idempotent', () => {
    const once = normalizeDescription('A\r\n\r\n\r\nB   \n')
    expect(normalizeDescription(once)).toBe(once)
  })
})

describe('canonicalizeSchema', () => {
  test('sorts keys recursively', () => {
    const canonical = canonicalizeSchema({ b: 1, a: { d: 2, c: 3 } })
    expect(canonicalJson(canonical)).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(Object.keys(canonical as Record<string, unknown>)).toEqual(['a', 'b'])
  })

  test('sorts `required`, which is a set, but leaves `enum` alone', () => {
    const canonical = canonicalizeSchema({
      required: ['b', 'a'],
      enum: ['z', 'y'],
    }) as Record<string, unknown>
    expect(canonical['required']).toEqual(['a', 'b'])
    expect(canonical['enum']).toEqual(['z', 'y'])
  })
})

describe('resolveInternalRefs', () => {
  test('inlines an internal ref and drops the now-dead $defs', () => {
    const { schema, unresolved } = resolveInternalRefs({
      type: 'object',
      $defs: { id: { type: 'string', minLength: 1 } },
      properties: { userId: { $ref: '#/$defs/id' } },
    })
    expect(unresolved).toEqual([])
    expect(schema).toEqual({
      properties: { userId: { minLength: 1, type: 'string' } },
      type: 'object',
    })
  })

  test('keywords beside a $ref override the resolved target', () => {
    const { schema } = resolveInternalRefs({
      $defs: { base: { type: 'string', description: 'from the def' } },
      properties: { field: { $ref: '#/$defs/base', description: 'overridden' } },
    })
    expect(schema).toEqual({
      properties: { field: { description: 'overridden', type: 'string' } },
    })
  })

  test('reports a cycle and leaves both the ref and its target in place', () => {
    const { schema, unresolved } = resolveInternalRefs({
      $defs: { node: { properties: { child: { $ref: '#/$defs/node' } }, type: 'object' } },
      properties: { root: { $ref: '#/$defs/node' } },
    })
    expect(unresolved).toEqual([{ ref: '#/$defs/node', reason: 'cycle' }])
    expect(schema['$defs']).toBeDefined()
  })

  test('reports an external ref without following it', () => {
    const { unresolved } = resolveInternalRefs({
      properties: { address: { $ref: 'https://schemas.example.com/address.json' } },
    })
    expect(unresolved).toEqual([
      { ref: 'https://schemas.example.com/address.json', reason: 'external' },
    ])
  })

  test('reports a dangling pointer', () => {
    const { unresolved } = resolveInternalRefs({ properties: { a: { $ref: '#/$defs/nope' } } })
    expect(unresolved).toEqual([{ ref: '#/$defs/nope', reason: 'missing' }])
  })
})

describe('normalizeTools', () => {
  test('sorts by name while keeping the served position', () => {
    const { tools } = normalizeTools([
      { name: 'zeta', inputSchema: { type: 'object' } },
      { name: 'alpha', inputSchema: { type: 'object' } },
    ])
    expect(tools.map((tool) => tool.name)).toEqual(['alpha', 'zeta'])
    expect(tools.map((tool) => tool.originalIndex)).toEqual([1, 0])
  })

  test('survives a malformed list and reports one diagnostic per problem', () => {
    const payload = readFixture('malformed.json') as { tools: RawTool[] }
    const { tools, diagnostics } = normalizeTools(payload.tools)

    expect(tools.map((tool) => tool.name)).toEqual(['count_items', 'describe_item', 'list_items'])

    const codes = diagnostics.map((diagnostic) => diagnostic.code).sort()
    expect(codes).toEqual([
      'surface/duplicate-tool-name',
      'surface/malformed-tool',
      'surface/missing-input-schema',
      'surface/missing-tool-name',
      'surface/non-string-description',
    ])
  })

  test('a non-string description is treated as absent, not coerced', () => {
    const { tools } = normalizeTools([
      { name: 't', description: { en: 'hello' }, inputSchema: { type: 'object' } },
    ])
    expect(tools[0]?.hasDescription).toBe(false)
    expect(tools[0]?.description).toBe('')
  })

  test('keeps the wire schema untouched while resolving a separate analysis view', () => {
    const { tools } = normalizeTools([
      {
        name: 't',
        description: 'd',
        inputSchema: {
          type: 'object',
          $defs: { id: { type: 'string' } },
          properties: { a: { $ref: '#/$defs/id' } },
        },
      },
    ])
    const tool = tools[0]!
    expect(tool.inputSchema['$defs']).toBeDefined()
    expect(tool.inputSchemaResolved['$defs']).toBeUndefined()
    expect(tool.inputSchemaResolved['properties']).toEqual({ a: { type: 'string' } })
  })
})
