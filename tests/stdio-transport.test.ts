import { describe, expect, test } from 'bun:test'
import { splitCommandLine, stdioTransportFromProcess } from '../src/core/transport/stdio.js'
import { MCP_PROTOCOL_VERSION, META_PROTOCOL_VERSION } from '../src/core/transport/mcp.js'
import type { McpProcess } from '../src/core/transport/types.js'
import { minimalChildEnvironment } from '../src/runtime/node.js'
import { caught } from './helpers.js'

interface FakeProcess extends McpProcess {
  written: string[]
  closed: boolean
}

/**
 * A scripted MCP server on the stdio binding. `reply` turns each request the transport
 * writes into the lines the server puts on stdout, so a test can interleave notifications,
 * blank lines and out-of-order replies the way a real server does.
 */
function fakeProcess(
  reply: (request: Record<string, unknown>, index: number) => string[],
  options: { stderr?: string } = {},
): FakeProcess {
  const written: string[] = []
  const pending: string[] = []
  let requestIndex = 0
  let closed = false

  return {
    written,
    get closed() {
      return closed
    },
    async writeLine(line) {
      written.push(line)
      pending.push(...reply(JSON.parse(line) as Record<string, unknown>, requestIndex))
      requestIndex += 1
    },
    async nextLine() {
      return pending.length > 0 ? (pending.shift() as string) : null
    },
    stderrText() {
      return options.stderr ?? ''
    },
    async close() {
      closed = true
    },
  }
}

const ONE_TOOL = [
  { name: 'get_thing', description: 'Return a thing.', inputSchema: { type: 'object' } },
]

function result(id: unknown, tools: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: { resultType: 'complete', tools, ...extra } })
}

describe('splitCommandLine', () => {
  test('splits on whitespace', () => {
    expect(splitCommandLine('bun run ./src/server.ts')).toEqual({
      command: 'bun',
      args: ['run', './src/server.ts'],
    })
  })

  test('keeps quoted arguments together', () => {
    expect(splitCommandLine(`node server.js --name "my server" --flag 'single quoted'`)).toEqual({
      command: 'node',
      args: ['server.js', '--name', 'my server', '--flag', 'single quoted'],
    })
  })

  test('leaves Windows path separators alone', () => {
    // A backslash escapes only a quote or another backslash; `\U` and `\s` are literal.
    expect(splitCommandLine(String.raw`node C:\data\app\server.js --flag`)).toEqual({
      command: 'node',
      args: [String.raw`C:\data\app\server.js`, '--flag'],
    })
    expect(splitCommandLine(String.raw`node "C:\Program Files\app\server.js"`)).toEqual({
      command: 'node',
      args: [String.raw`C:\Program Files\app\server.js`],
    })
  })

  test('still escapes a quote and a backslash', () => {
    expect(splitCommandLine(String.raw`node --msg "say \"hi\"" --path a\\b`)).toEqual({
      command: 'node',
      args: ['--msg', 'say "hi"', '--path', String.raw`a\b`],
    })
  })

  test('does not interpret shell metacharacters, it only tokenises', () => {
    // The point is that `;` never separates commands: it stays inside one argument.
    expect(splitCommandLine("server --x 'a; rm -rf /'")).toEqual({
      command: 'server',
      args: ['--x', 'a; rm -rf /'],
    })
  })

  test('rejects an unbalanced quote instead of guessing', () => {
    expect(() => splitCommandLine(`node "unterminated`)).toThrow(/Unbalanced/)
  })

  test('rejects an empty command line', () => {
    expect(() => splitCommandLine('   ')).toThrow(/empty/)
  })
})

describe('stdio child environment', () => {
  test('passes only runtime essentials and explicitly configured values', () => {
    const child = minimalChildEnvironment(
      {
        PATH: '/bin',
        HOME: '/home/test',
        OPENAI_API_KEY: 'host-secret',
        WHICHTOOL_HTTP_AUTHORIZATION: 'Bearer host-secret',
        INTERNAL_TOKEN: 'host-secret',
      },
      { TARGET_API_KEY: 'explicit-target-secret', PATH: '/custom/bin' },
    )
    expect(child['PATH']).toBe('/custom/bin')
    expect(child['HOME']).toBe('/home/test')
    expect(child['TARGET_API_KEY']).toBe('explicit-target-secret')
    expect(child['OPENAI_API_KEY']).toBeUndefined()
    expect(child['WHICHTOOL_HTTP_AUTHORIZATION']).toBeUndefined()
    expect(child['INTERNAL_TOKEN']).toBeUndefined()
  })
})

describe('the stdio transport', () => {
  test('writes one newline-free JSON-RPC message and reads the reply', async () => {
    const child = fakeProcess((request) => [result(request['id'], ONE_TOOL)])
    const listed = await stdioTransportFromProcess(child, 'fake').listTools()

    expect(listed.tools.map((tool) => tool.name)).toEqual(['get_thing'])
    expect(child.written).toHaveLength(1)
    expect(child.written[0]).not.toContain('\n')
  })

  test('carries the same _meta the HTTP binding carries, with no header layer', async () => {
    const child = fakeProcess((request) => [result(request['id'], ONE_TOOL)])
    await stdioTransportFromProcess(child, 'fake').listTools()

    const sent = JSON.parse(child.written[0]!) as { params: { _meta: Record<string, unknown> } }
    expect(sent.params._meta[META_PROTOCOL_VERSION]).toBe(MCP_PROTOCOL_VERSION)
  })

  test('skips notifications and replies to other ids on the shared channel', async () => {
    const child = fakeProcess((request) => [
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'info' },
      }),
      '',
      JSON.stringify({ jsonrpc: '2.0', id: 4242, result: { resultType: 'complete', tools: [] } }),
      result(request['id'], ONE_TOOL),
    ])
    const listed = await stdioTransportFromProcess(child, 'fake').listTools()
    expect(listed.tools).toHaveLength(1)
  })

  test('paginates the same way HTTP does, because pagination is a protocol concern', async () => {
    const child = fakeProcess((request, index) =>
      index === 0
        ? [
            result(request['id'], [{ name: 'a', description: 'A.', inputSchema: {} }], {
              nextCursor: 'p2',
            }),
          ]
        : [result(request['id'], [{ name: 'b', description: 'B.', inputSchema: {} }])],
    )
    const listed = await stdioTransportFromProcess(child, 'fake').listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual(['a', 'b'])
    expect(listed.meta).toMatchObject({ pages: 2 })
  })

  test('explains a server that logs to stdout, which the spec forbids', async () => {
    const child = fakeProcess(() => ['Listening on port 3000...'])
    const error = await caught(stdioTransportFromProcess(child, 'fake').listTools())
    expect(error.message).toContain('not valid JSON')
    expect(error.hint).toContain('logging belongs on stderr')
  })

  test('refuses an oversized response before parsing it', async () => {
    const child = fakeProcess(() => [' '.repeat(16 * 1024 * 1024 + 1) + '{}'])
    const error = await caught(stdioTransportFromProcess(child, 'fake').listTools())
    expect((error as Error & { code?: string }).code).toBe('stdio/response-too-large')
  })

  test('quotes stderr when the server dies without answering', async () => {
    const child = fakeProcess(() => [], { stderr: 'Traceback...\nModuleNotFoundError: no mcp\n' })
    const error = await caught(stdioTransportFromProcess(child, 'fake').listTools())
    expect(error.message).toContain('closed its output stream')
    expect(error.hint).toContain('ModuleNotFoundError')
  })

  test('times out rather than hanging forever', async () => {
    const child: McpProcess = {
      async writeLine() {},
      nextLine: () => new Promise<string | null>(() => undefined),
      stderrText: () => '',
      async close() {},
    }
    await expect(
      stdioTransportFromProcess(child, 'fake', { timeoutMs: 25 }).listTools(),
    ).rejects.toThrow(/within 25 ms/)
  })

  test('closing the transport shuts the process down', async () => {
    const child = fakeProcess((request) => [result(request['id'], ONE_TOOL)])
    const transport = stdioTransportFromProcess(child, 'fake')
    await transport.listTools()
    await transport.close?.()
    expect(child.closed).toBe(true)
  })
})
