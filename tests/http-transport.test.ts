import { describe, expect, test } from 'bun:test'
import { createHttpTransport } from '../src/core/transport/http.js'
import {
  MCP_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  redactUrl,
} from '../src/core/transport/mcp.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import { caught } from './helpers.js'

const URL_UNDER_TEST = 'https://example.test/mcp'

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  redirect: RequestInit['redirect']
}

interface FakeServer {
  fetch: typeof fetch
  requests: CapturedRequest[]
}

/** A fetch stand-in that records what whichtool sent and replies with what the test wants. */
function fakeServer(
  handler: (request: CapturedRequest, index: number) => Response | Promise<Response>,
): FakeServer {
  const requests: CapturedRequest[] = []
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    const captured: CapturedRequest = {
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      redirect: init?.redirect,
    }
    requests.push(captured)
    return handler(captured, requests.length - 1)
  }) as unknown as typeof fetch
  return { fetch: doFetch, requests }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(events: string[]): Response {
  return new Response(`${events.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function toolsResult(id: number, tools: unknown[], extra: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, result: { resultType: 'complete', tools, ...extra } }
}

const ONE_TOOL = [
  { name: 'get_thing', description: 'Return a thing.', inputSchema: { type: 'object' } },
]

describe('the request whichtool sends', () => {
  test('carries exactly the routing headers the binding requires', async () => {
    const server = fakeServer((request) =>
      jsonResponse(toolsResult(request.body['id'] as number, ONE_TOOL)),
    )
    const transport = createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch })
    await transport.listTools()

    const headers = server.requests[0]!.headers
    expect(headers['mcp-protocol-version']).toBe(MCP_PROTOCOL_VERSION)
    expect(headers['mcp-method']).toBe('tools/list')
    expect(headers['content-type']).toBe('application/json')
    // The client MUST list both content types; the server picks one.
    expect(headers['accept']).toContain('application/json')
    expect(headers['accept']).toContain('text/event-stream')
  })

  test('omits Mcp-Name, which the spec requires only for requests that name a target', async () => {
    const server = fakeServer((request) =>
      jsonResponse(toolsResult(request.body['id'] as number, ONE_TOOL)),
    )
    await createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools()
    expect(server.requests[0]!.headers['mcp-name']).toBeUndefined()
  })

  test('carries the required _meta fields, with the version matching the header', async () => {
    const server = fakeServer((request) =>
      jsonResponse(toolsResult(request.body['id'] as number, ONE_TOOL)),
    )
    await createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools()

    const request = server.requests[0]!
    const meta = (request.body['params'] as Record<string, Record<string, unknown>>)['_meta']!
    expect(meta[META_PROTOCOL_VERSION]).toBe(MCP_PROTOCOL_VERSION)
    // A mismatch between the two is a -32020 HeaderMismatch, so pin that they agree.
    expect(meta[META_PROTOCOL_VERSION]).toBe(request.headers['mcp-protocol-version'])
    expect(meta[META_CLIENT_CAPABILITIES]).toEqual({})
    expect(meta[META_CLIENT_INFO]).toMatchObject({ name: 'whichtool' })
  })

  test('posts a well-formed JSON-RPC request', async () => {
    const server = fakeServer((request) =>
      jsonResponse(toolsResult(request.body['id'] as number, ONE_TOOL)),
    )
    await createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools()
    expect(server.requests[0]!.body).toMatchObject({ jsonrpc: '2.0', method: 'tools/list' })
    expect(typeof server.requests[0]!.body['id']).toBe('number')
  })

  test('refuses redirects rather than forwarding caller headers elsewhere', async () => {
    const server = fakeServer((request) =>
      jsonResponse(toolsResult(request.body['id'] as number, ONE_TOOL)),
    )
    await createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools()
    expect(server.requests[0]!.redirect).toBe('error')
  })

  test('merges caller headers but never lets them break protocol compliance', async () => {
    const server = fakeServer((request) =>
      jsonResponse(toolsResult(request.body['id'] as number, ONE_TOOL)),
    )
    await createHttpTransport({
      url: URL_UNDER_TEST,
      fetch: server.fetch,
      headers: { Authorization: 'Bearer t0ken', 'Mcp-Method': 'tools/call', accept: 'text/plain' },
    }).listTools()

    const headers = server.requests[0]!.headers
    expect(headers['authorization']).toBe('Bearer t0ken')
    expect(headers['mcp-method']).toBe('tools/list')
    expect(headers['accept']).toContain('text/event-stream')
  })
})

describe('reading the response', () => {
  test('reads a single JSON object', async () => {
    const server = fakeServer((request) =>
      jsonResponse(toolsResult(request.body['id'] as number, ONE_TOOL)),
    )
    const listed = await createHttpTransport({
      url: URL_UNDER_TEST,
      fetch: server.fetch,
    }).listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual(['get_thing'])
  })

  test('reads an SSE stream, skipping notifications and keep-alive comments', async () => {
    const server = fakeServer((request) =>
      sseResponse([
        ':',
        `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}`,
        ':keep-alive',
        `data: ${JSON.stringify(toolsResult(request.body['id'] as number, ONE_TOOL))}`,
      ]),
    )
    const listed = await createHttpTransport({
      url: URL_UNDER_TEST,
      fetch: server.fetch,
    }).listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual(['get_thing'])
  })

  test('handles an SSE stream framed with CRLF', async () => {
    const server = fakeServer((request) => {
      const payload = JSON.stringify(toolsResult(request.body['id'] as number, ONE_TOOL))
      return new Response(`data: ${payload}\r\n\r\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const listed = await createHttpTransport({
      url: URL_UNDER_TEST,
      fetch: server.fetch,
    }).listTools()
    expect(listed.tools).toHaveLength(1)
  })

  test('follows nextCursor to the end and says how many pages it read', async () => {
    const server = fakeServer((request, index) => {
      const id = request.body['id'] as number
      if (index === 0) {
        return jsonResponse(
          toolsResult(id, [{ name: 'a', description: 'A.', inputSchema: {} }], {
            nextCursor: 'p2',
          }),
        )
      }
      return jsonResponse(toolsResult(id, [{ name: 'b', description: 'B.', inputSchema: {} }]))
    })
    const listed = await createHttpTransport({
      url: URL_UNDER_TEST,
      fetch: server.fetch,
    }).listTools()

    expect(listed.tools.map((tool) => tool.name)).toEqual(['a', 'b'])
    expect(server.requests[1]!.body['params']).toMatchObject({ cursor: 'p2' })
    expect(listed.meta).toMatchObject({ pages: 2 })
    expect(listed.diagnostics.map((d) => d.code)).toContain('mcp/paginated')
  })

  test('refuses a server that returns the same cursor forever', async () => {
    const server = fakeServer((request) =>
      jsonResponse(toolsResult(request.body['id'] as number, [], { nextCursor: 'same' })),
    )
    await expect(
      createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools(),
    ).rejects.toThrow(/does not terminate/)
  })

  test('captures the cache directives and flags a publicly cacheable surface', async () => {
    const server = fakeServer((request) =>
      jsonResponse(
        toolsResult(request.body['id'] as number, ONE_TOOL, {
          ttlMs: 300000,
          cacheScope: 'public',
        }),
      ),
    )
    const listed = await createHttpTransport({
      url: URL_UNDER_TEST,
      fetch: server.fetch,
    }).listTools()
    expect(listed.meta).toMatchObject({ ttlMs: 300000, cacheScope: 'public' })
    expect(listed.diagnostics.map((d) => d.code)).toContain('mcp/public-cache-scope')
  })

  test('records the server identity when the server sends one', async () => {
    const server = fakeServer((request) =>
      jsonResponse(
        toolsResult(request.body['id'] as number, ONE_TOOL, {
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'demo', version: '2.1.0' } },
        }),
      ),
    )
    const listed = await createHttpTransport({
      url: URL_UNDER_TEST,
      fetch: server.fetch,
    }).listTools()
    expect(listed.meta).toMatchObject({ serverInfo: { name: 'demo', version: '2.1.0' } })
  })

  test('treats a missing resultType as complete, for servers on an older revision', async () => {
    const server = fakeServer((request) =>
      jsonResponse({ jsonrpc: '2.0', id: request.body['id'], result: { tools: ONE_TOOL } }),
    )
    const listed = await createHttpTransport({
      url: URL_UNDER_TEST,
      fetch: server.fetch,
    }).listTools()
    expect(listed.tools).toHaveLength(1)
  })

  test('refuses input_required rather than pretending to answer it', async () => {
    const server = fakeServer((request) =>
      jsonResponse({
        jsonrpc: '2.0',
        id: request.body['id'],
        result: { resultType: 'input_required', tools: [], inputRequests: {} },
      }),
    )
    await expect(
      createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools(),
    ).rejects.toThrow(/input_required/)
  })

  test('raises rather than reporting an empty surface when the result is malformed', async () => {
    const server = fakeServer((request) =>
      jsonResponse({ jsonrpc: '2.0', id: request.body['id'], result: { resultType: 'complete' } }),
    )
    await expect(
      createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools(),
    ).rejects.toThrow(/no `tools` array/)
  })

  test('rejects an answer addressed to a different request id', async () => {
    const server = fakeServer(() => jsonResponse(toolsResult(999, ONE_TOOL)))
    await expect(
      createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools(),
    ).rejects.toThrow(/id 999/)
  })

  test('rejects a content type the binding does not allow', async () => {
    const server = fakeServer(
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    await expect(
      createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools(),
    ).rejects.toThrow(/text\/html/)
  })

  test('rejects an oversized JSON response before buffering it', async () => {
    const server = fakeServer(
      () =>
        new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(16 * 1024 * 1024 + 1),
          },
        }),
    )
    const error = await caught(
      createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools(),
    )
    expect((error as Error & { code?: string }).code).toBe('http/response-too-large')
  })
})

describe('error mapping', () => {
  const cases = [
    {
      name: 'unsupported protocol version lists what the server does support',
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32022, message: 'no', data: { supported: ['2025-11-25'] } },
      },
      expected: /does not support MCP 2026-07-28.*2025-11-25/s,
    },
    {
      name: 'missing client capability names the capability',
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32021, message: 'no', data: { requiredCapabilities: ['sampling'] } },
      },
      expected: /sampling/,
    },
    {
      name: 'header mismatch quotes what the server objected to',
      status: 400,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32020, message: 'Mcp-Method mismatch' } },
      expected: /rejected the request headers: Mcp-Method mismatch/,
    },
    {
      name: 'method not found means there is no surface to measure',
      status: 404,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
      expected: /does not implement tools\/list/,
    },
  ]

  for (const item of cases) {
    test(item.name, async () => {
      const server = fakeServer(() => jsonResponse(item.body, item.status))
      await expect(
        createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools(),
      ).rejects.toThrow(item.expected)
    })
  }

  test('a header mismatch blames whichtool, because only whichtool builds those headers', async () => {
    const server = fakeServer(() =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32020, message: 'mismatch' } }, 400),
    )
    const error = await caught(
      createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools(),
    )
    expect(error.hint).toContain('bug in whichtool')
  })

  test('a 400 with no recognisable MCP error is called out as a probable legacy server', async () => {
    const server = fakeServer(() => new Response('', { status: 400 }))
    const error = await caught(
      createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools(),
    )
    expect(error.message).toContain('HTTP 400')
    expect(error.hint).toContain('2024-11-05 HTTP+SSE')
  })

  test('a 401 suggests the environment variable rather than a config field', async () => {
    const server = fakeServer(() => new Response('nope', { status: 401 }))
    const error = await caught(
      createHttpTransport({ url: URL_UNDER_TEST, fetch: server.fetch }).listTools(),
    )
    expect(error.hint).toContain('WHICHTOOL_HTTP_AUTHORIZATION')
  })

  test('a network failure names the target and the cause', async () => {
    const doFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(
      createHttpTransport({ url: URL_UNDER_TEST, fetch: doFetch }).listTools(),
    ).rejects.toThrow(/Cannot reach https:\/\/example.test\/mcp: ECONNREFUSED/)
  })
})

describe('credentials never reach an artifact', () => {
  test('redactUrl strips userinfo and credential-prone URL values', () => {
    expect(redactUrl('https://user:s3cret@example.test/mcp')).toBe('https://***@example.test/mcp')
    expect(redactUrl('https://example.test/mcp')).toBe('https://example.test/mcp')
    expect(redactUrl('https://example.test/mcp?api_key=secret#secret')).toBe(
      'https://example.test/mcp?api_key=***#***',
    )
  })

  test('neither the transport ref nor the surface carries the token', async () => {
    const server = fakeServer((request) =>
      jsonResponse(toolsResult(request.body['id'] as number, ONE_TOOL)),
    )
    const urlToken = 'deadbeefcafef00ddeadbeefcafef00d'
    const transport = createHttpTransport({
      url: `https://user:s3cret@example.test/mcp/${urlToken}?api_key=${urlToken}#${urlToken}`,
      fetch: server.fetch,
      headers: { Authorization: 'Bearer t0ken' },
    })
    const surface = await loadSurface(transport)

    const serialized = JSON.stringify(surface)
    expect(serialized).not.toContain('s3cret')
    expect(serialized).not.toContain('t0ken')
    expect(serialized).not.toContain(urlToken)
    expect(surface.source.ref).toBe('https://***@example.test/mcp/***?api_key=***#***')
  })

  test('network and HTTP errors scrub echoed target URLs and authorization values', async () => {
    const urlToken = 'deadbeefcafef00ddeadbeefcafef00d'
    const authorization = 'Bearer target-auth-secret-123456'
    const visibleHeader = 'visible-context'
    const url = `https://example.test/mcp/${urlToken}?api_key=${urlToken}#${urlToken}`
    const headers = { Authorization: authorization, 'x-request-context': visibleHeader }

    const networkFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const sent = new Headers(init?.headers)
      throw new Error(
        `${String(input)} ${sent.get('authorization')} ${sent.get('x-request-context')}`,
      )
    }) as unknown as typeof fetch
    const networkError = await caught(
      createHttpTransport({ url, headers, fetch: networkFetch }).listTools(),
    )

    const server = fakeServer((request) =>
      jsonResponse(
        {
          jsonrpc: '2.0',
          id: request.body['id'],
          error: {
            code: -32000,
            message: `${request.url} ${request.headers['authorization']} ${request.headers['x-request-context']}`,
          },
        },
        500,
      ),
    )
    const responseError = await caught(
      createHttpTransport({ url, headers, fetch: server.fetch }).listTools(),
    )

    for (const error of [networkError, responseError]) {
      expect(error.message).not.toContain(urlToken)
      expect(error.message).not.toContain('target-auth-secret-123456')
      expect(error.message).toContain(visibleHeader)
    }
  })
})
