import { describe, expect, test } from 'bun:test'
import { canonicalJson } from '../src/core/json.js'
import { computeSurfaceHash, sha256Hex, shortHash } from '../src/core/surface/hash.js'
import { normalizeTools } from '../src/core/surface/normalize.js'
import type { RawTool } from '../src/core/types.js'

async function hashOf(tools: RawTool[]): Promise<string> {
  return computeSurfaceHash(normalizeTools(tools).tools)
}

const BASE: RawTool[] = [
  {
    name: 'list_users',
    description: 'List the users in the workspace.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'get_user',
    description: 'Return one user by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
]

describe('canonicalJson', () => {
  test('sorts object keys and preserves array order', () => {
    expect(canonicalJson({ b: [3, 1, 2], a: 1 })).toBe('{"a":1,"b":[3,1,2]}')
  })

  test('is stable across differently ordered but equal inputs', () => {
    expect(canonicalJson({ a: { y: 1, x: 2 } })).toBe(canonicalJson({ a: { x: 2, y: 1 } }))
  })
})

describe('sha256Hex', () => {
  test("matches the published vector for 'abc'", async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('computeSurfaceHash', () => {
  test('is stable when the server reorders its registrations', async () => {
    expect(await hashOf(BASE)).toBe(await hashOf([...BASE].reverse()))
  })

  test('is stable across CRLF and trailing-whitespace churn', async () => {
    const churned = BASE.map((tool) => ({
      ...tool,
      description: `${(tool.description as string).replace(' ', '  \r\n')}   `,
    }))
    // Interior spacing does change the text, so only the churn we normalise is neutral.
    const onlyChurn = BASE.map((tool) => ({
      ...tool,
      description: `${tool.description as string}  \r\n`,
    }))
    expect(await hashOf(onlyChurn)).toBe(await hashOf(BASE))
    expect(await hashOf(churned)).not.toBe(await hashOf(BASE))
  })

  test('survives a $ref refactor, because it changes no semantics', async () => {
    const inline: RawTool[] = [
      {
        name: 't',
        description: 'd',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'string', minLength: 1 } },
        },
      },
    ]
    const viaDefs: RawTool[] = [
      {
        name: 't',
        description: 'd',
        inputSchema: {
          type: 'object',
          $defs: { id: { type: 'string', minLength: 1 } },
          properties: { a: { $ref: '#/$defs/id' } },
        },
      },
    ]
    expect(await hashOf(viaDefs)).toBe(await hashOf(inline))
  })

  test('changes when a description changes', async () => {
    const edited = BASE.map((tool, index) =>
      index === 0 ? { ...tool, description: 'List every user in the workspace.' } : tool,
    )
    expect(await hashOf(edited)).not.toBe(await hashOf(BASE))
  })

  test('changes when an annotation changes', async () => {
    const annotated = BASE.map((tool, index) =>
      index === 0 ? { ...tool, annotations: { readOnlyHint: true } } : tool,
    )
    expect(await hashOf(annotated)).not.toBe(await hashOf(BASE))
  })

  test('is prefixed so the algorithm is never ambiguous', async () => {
    const hash = await hashOf(BASE)
    expect(hash.startsWith('sha256:')).toBe(true)
    expect(shortHash(hash)).toHaveLength(12)
  })
})
