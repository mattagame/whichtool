import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { NotImplementedError, WhichtoolError } from '../src/core/errors.js'
import {
  createSnapshotTransport,
  createTransport,
  extractTools,
  snapshotTransportFromData,
} from '../src/core/transport/index.js'
import { fixturePath, readFixture } from './helpers.js'

const deps = { readTextFile: (path: string) => readFile(path, 'utf8') }

describe('extractTools', () => {
  test('accepts a bare result object', () => {
    expect(extractTools({ tools: [{ name: 'a' }] }, 'x').shape).toBe('result')
  })

  test('accepts a full JSON-RPC envelope', () => {
    const payload = readFixture('jsonrpc-envelope.json')
    const extracted = extractTools(payload, 'jsonrpc-envelope.json')
    expect(extracted.shape).toBe('jsonrpc')
    expect(extracted.tools.map((tool) => tool.name)).toEqual(['get_weather', 'get_forecast'])
  })

  test('accepts a bare array', () => {
    expect(extractTools([{ name: 'a' }], 'x').shape).toBe('array')
  })

  test('refuses a JSON-RPC error response instead of reporting an empty surface', () => {
    expect(() => extractTools({ error: { code: -32601, message: 'no' } }, 'x')).toThrow(
      WhichtoolError,
    )
  })

  test('refuses anything it does not recognise', () => {
    expect(() => extractTools({ nope: true }, 'x')).toThrow(/does not contain a tool list/)
  })
})

describe('snapshot transport', () => {
  test('reads a captured tool list from disk', async () => {
    const transport = await createSnapshotTransport(fixturePath('clean.json'), deps)
    expect(transport.kind).toBe('snapshot')
    const listed = await transport.listTools()
    expect(listed.tools).toHaveLength(4)
    expect(listed.diagnostics).toEqual([])
  })

  test('notes when a bare array cost us the transport metadata', async () => {
    const transport = snapshotTransportFromData([{ name: 'a' }], 'inline')
    const listed = await transport.listTools()
    expect(listed.diagnostics.map((d) => d.code)).toEqual(['snapshot/bare-array'])
  })

  test('says which file was unreadable rather than failing opaquely', async () => {
    await expect(createSnapshotTransport(fixturePath('does-not-exist.json'), deps)).rejects.toThrow(
      /Cannot read snapshot/,
    )
  })

  test('reports invalid JSON as invalid JSON', async () => {
    const badDeps = { readTextFile: async () => '{ not json' }
    await expect(createSnapshotTransport('x.json', badDeps)).rejects.toThrow(/not valid JSON/)
  })
})

describe('createTransport', () => {
  test('builds a snapshot transport', async () => {
    const transport = await createTransport(
      { transport: 'snapshot', path: fixturePath('clean.json') },
      deps,
    )
    expect(transport.kind).toBe('snapshot')
  })

  test('builds an http transport without touching the network', async () => {
    const transport = await createTransport(
      { transport: 'http', url: 'https://example.test/mcp' },
      deps,
    )
    expect(transport.kind).toBe('http')
    expect(transport.ref).toBe('https://example.test/mcp')
  })

  test('refuses the deprecated HTTP+SSE transport and says where it stands', async () => {
    const error = await createTransport(
      { transport: 'legacy-sse', url: 'https://example.com/sse' },
      deps,
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(NotImplementedError)
    expect((error as NotImplementedError).hint).toContain('Deprecated since MCP 2025-03-26')
  })

  test('stdio needs a spawn capability and says so when it has none', async () => {
    const error = await createTransport(
      { transport: 'stdio', command: 'bun run ./server.ts' },
      deps,
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(WhichtoolError)
    expect((error as WhichtoolError).code).toBe('stdio/no-spawn')
  })

  test('rejects an unknown transport by name', async () => {
    const error = await createTransport({ transport: 'carrier-pigeon' } as never, deps).catch(
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(WhichtoolError)
    expect((error as WhichtoolError).code).toBe('target/unknown-transport')
  })
})
