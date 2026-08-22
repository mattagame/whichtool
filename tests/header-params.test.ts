import { describe, expect, test } from 'bun:test'
import { analyzeHeaderParams, collectHeaderAnnotations } from '../src/core/static/header-params.js'
import { normalizeTools } from '../src/core/surface/normalize.js'
import type { JsonSchema, RawTool } from '../src/core/types.js'

function analyze(inputSchema: JsonSchema, name = 't') {
  const tool: RawTool = { name, description: 'A tool.', inputSchema }
  return analyzeHeaderParams(normalizeTools([tool]).tools)
}

const VALID: JsonSchema = {
  type: 'object',
  properties: {
    region: { type: 'string', description: 'Where to run.', 'x-mcp-header': 'Region' },
    query: { type: 'string', description: 'The query.' },
  },
  required: ['region', 'query'],
}

describe('collectHeaderAnnotations', () => {
  test('finds an annotation on a top-level property and calls it reachable', () => {
    const found = collectHeaderAnnotations(VALID)
    expect(found).toHaveLength(1)
    expect(found[0]?.path).toBe('/properties/region')
    expect(found[0]?.staticallyReachable).toBe(true)
  })

  test('a nested chain of properties keys is still reachable', () => {
    const found = collectHeaderAnnotations({
      type: 'object',
      properties: {
        target: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'R' } } },
      },
    })
    expect(found[0]?.staticallyReachable).toBe(true)
  })

  test('a path through items or a composition keyword is not reachable', () => {
    for (const schema of [
      { properties: { list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'R' } } } },
      { oneOf: [{ properties: { region: { type: 'string', 'x-mcp-header': 'R' } } }] },
      { properties: { a: { if: { properties: { r: { type: 'string', 'x-mcp-header': 'R' } } } } } },
    ] as JsonSchema[]) {
      const found = collectHeaderAnnotations(schema)
      expect(found).toHaveLength(1)
      expect(found[0]?.staticallyReachable).toBe(false)
    }
  })
})

describe('analyzeHeaderParams', () => {
  test('a valid annotation is reported for awareness, not as a fault', () => {
    const analysis = analyze(VALID)
    expect(analysis.rejectedTools).toEqual([])
    expect(analysis.diagnostics.map((d) => d.code)).toEqual(['x-mcp-header/present'])
    expect(analysis.diagnostics[0]?.severity).toBe('info')
    expect(analysis.diagnostics[0]?.message).toContain('visible to every intermediary')
  })

  test('a surface with no annotations produces nothing', () => {
    expect(analyze({ type: 'object', properties: { a: { type: 'string' } } }).diagnostics).toEqual(
      [],
    )
  })

  const invalid: Array<{ name: string; schema: JsonSchema; expect: RegExp }> = [
    {
      name: 'an empty value',
      schema: { properties: { a: { type: 'string', 'x-mcp-header': '' } } },
      expect: /the value is empty/,
    },
    {
      name: 'a value that is not an HTTP token',
      schema: { properties: { a: { type: 'string', 'x-mcp-header': 'my header' } } },
      expect: /not a valid HTTP field-name token/,
    },
    {
      name: 'a value containing a newline',
      schema: { properties: { a: { type: 'string', 'x-mcp-header': 'R\nX' } } },
      expect: /not a valid HTTP field-name token/,
    },
    {
      name: 'a value that is not a string',
      schema: { properties: { a: { type: 'string', 'x-mcp-header': true } } },
      expect: /not a string/,
    },
    {
      name: 'two values colliding case-insensitively',
      schema: {
        properties: {
          a: { type: 'string', 'x-mcp-header': 'Region' },
          b: { type: 'string', 'x-mcp-header': 'region' },
        },
      },
      expect: /collides case-insensitively/,
    },
    {
      name: 'a number parameter, which the spec singles out',
      schema: { properties: { a: { type: 'number', 'x-mcp-header': 'R' } } },
      expect: /`number` parameters may not be mirrored/,
    },
    {
      name: 'a non-primitive parameter',
      schema: { properties: { a: { type: 'object', 'x-mcp-header': 'R' } } },
      expect: /only string, integer and boolean/,
    },
    {
      name: 'a property with no declared type',
      schema: { properties: { a: { 'x-mcp-header': 'R' } } },
      expect: /declares no `type`/,
    },
    {
      name: 'an annotation reached through an array',
      schema: {
        properties: { a: { type: 'array', items: { type: 'string', 'x-mcp-header': 'R' } } },
      },
      expect: /not statically reachable/,
    },
  ]

  for (const item of invalid) {
    test(`rejects ${item.name}`, () => {
      const analysis = analyze(item.schema)
      expect(analysis.rejectedTools).toEqual(['t'])
      const finding = analysis.diagnostics.find((d) => d.code === 'x-mcp-header/invalid')
      expect(finding?.severity).toBe('error')
      expect(finding?.message).toMatch(item.expect)
    })
  }

  test('says plainly that the model will never see a rejected tool', () => {
    const analysis = analyze({ properties: { a: { type: 'number', 'x-mcp-header': 'R' } } })
    expect(analysis.diagnostics[0]?.message).toContain('the model never sees this tool')
  })

  test('integer and boolean are allowed; only number is not', () => {
    for (const type of ['integer', 'boolean', 'string']) {
      const analysis = analyze({ properties: { a: { type, 'x-mcp-header': 'R' } } })
      expect(analysis.rejectedTools).toEqual([])
    }
  })

  test('one broken tool does not implicate its neighbours', () => {
    const { tools } = normalizeTools([
      { name: 'good', description: 'Fine.', inputSchema: VALID },
      {
        name: 'bad',
        description: 'Broken.',
        inputSchema: { properties: { a: { type: 'number', 'x-mcp-header': 'R' } } },
      },
    ])
    expect(analyzeHeaderParams(tools).rejectedTools).toEqual(['bad'])
  })
})
