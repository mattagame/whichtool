import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { EXIT, main } from '../src/cli/run.js'
import { stripCredentials } from '../src/core/providers/http.js'
import { createOpenAiCompatibleProvider } from '../src/core/providers/openai-compatible.js'
import { redactUrl } from '../src/core/transport/index.js'
import { createFakeRuntime, fixturePath, REPO_ROOT } from './helpers.js'

const TASKS_FILE = join(REPO_ROOT, 'tests', 'fixtures', 'tasks', 'list-search.tasks.yaml')
const API_KEY = 'sk-secret-leaky-key-DO-NOT-EMIT'
const HTTP_TOKEN = 'Bearer secret-http-token-DO-NOT-EMIT'

function dump(parts: string[]): string {
  return parts.join('\n')
}

describe('credentials never reach an artifact', () => {
  test('a provider API key is not in errors, the provider object, or pick results', async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      apiKey: API_KEY,
      retries: 0,
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: 'nope' } }), {
          status: 401,
        })) as unknown as typeof fetch,
    })

    let message = ''
    try {
      await provider.pick({
        tools: [],
        prompt: 'list users',
        temperature: 0,
      })
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause)
    }

    const serialized = dump([message, JSON.stringify(provider)])
    expect(serialized).not.toContain(API_KEY)
    expect(serialized).not.toContain('sk-secret')
  })

  test('OPENAI_API_KEY and HTTP authorization do not appear in CLI output or saved reports', async () => {
    const runtime = createFakeRuntime({
      env: {
        OPENAI_API_KEY: API_KEY,
        WHICHTOOL_HTTP_AUTHORIZATION: HTTP_TOKEN,
      },
    })
    const code = await main(
      [
        'run',
        fixturePath('list-search-pair.json'),
        '--tasks',
        TASKS_FILE,
        '--provider',
        'mock',
        '--repeat',
        '1',
        '--format',
        'json',
        '--out',
        'run.json',
      ],
      runtime,
    )
    expect(code).toBe(EXIT.ok)

    const inspectRuntime = createFakeRuntime({
      env: {
        OPENAI_API_KEY: API_KEY,
        WHICHTOOL_HTTP_AUTHORIZATION: HTTP_TOKEN,
      },
    })
    await main(
      ['inspect', fixturePath('list-search-pair.json'), '--format', 'json'],
      inspectRuntime,
    )

    const blob = dump([
      runtime.out(),
      runtime.err(),
      inspectRuntime.out(),
      inspectRuntime.err(),
      ...runtime.writes().values(),
      ...inspectRuntime.writes().values(),
    ])
    expect(blob).not.toContain(API_KEY)
    expect(blob).not.toContain('secret-http-token')
    expect(blob).not.toContain(HTTP_TOKEN)
  })
})

describe('URL credentials never reach display values', () => {
  const SECRET_URL =
    'https://user:tok3n@host.example/mcp/deadbeefcafef00ddeadbeefcafef00d/message?api_key=deadbeefcafef00ddeadbeefcafef00d&region=eu#fragment-secret'

  test('target and provider redaction cover userinfo, token-like paths, query values and hashes', () => {
    const expected = 'https://***@host.example/mcp/***/message?api_key=***&region=***#***'
    expect(redactUrl(SECRET_URL)).toBe(expected)
    expect(stripCredentials(SECRET_URL)).toBe(expected)
    expect(redactUrl('not-a-url-with-secret-token')).toBe('(invalid URL)')
  })

  test('provider fingerprints ignore URL credentials but retain non-sensitive behaviour knobs', async () => {
    const make = (secret: string, apiVersion: string) =>
      createOpenAiCompatibleProvider({
        baseUrl: `https://user:${secret}@host.example/v1/${secret}?api_key=${secret}&api-version=${apiVersion}#${secret}`,
        model: 'gpt-test',
        retries: 0,
        fetch: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
      })

    const firstSecret = 'deadbeefcafef00ddeadbeefcafef00d'
    const secondSecret = 'deadbeefcafef00ddeadbeefcafef00e'
    const first = make(firstSecret, '2026-08-01')
    const second = make(secondSecret, '2026-08-01')
    const versionChanged = make(secondSecret, '2026-08-02')
    expect(first.endpoint).not.toContain(firstSecret)
    expect(first.endpoint).toContain('***')
    expect(await first.behaviorFingerprint?.()).toBe(await second.behaviorFingerprint?.())
    expect(await first.behaviorFingerprint?.()).not.toBe(
      await versionChanged.behaviorFingerprint?.(),
    )
    expect(await first.cacheFingerprint?.()).not.toBe(await second.cacheFingerprint?.())

    let message = ''
    try {
      await first.pick({ tools: [], prompt: 'x', temperature: 0 })
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause)
    }
    expect(message).not.toContain(firstSecret)
    expect(JSON.stringify(first)).not.toContain(firstSecret)
  })

  test('provider network and HTTP errors scrub echoed endpoints and credential headers', async () => {
    const endpointSecret = 'deadbeefcafef00ddeadbeefcafef00d'
    const apiKey = 'sk-echoed-api-key-123456'
    const tokenHeader = 'echoed-token-header-123456'
    const cookieSecret = 'echoed-cookie-secret-123456'
    const visibleHeader = 'visible-context'

    const echoed = (input: string | URL | Request, init?: RequestInit): string => {
      const headers = new Headers(init?.headers)
      return [
        String(input),
        headers.get('authorization'),
        headers.get('x-api-token'),
        headers.get('cookie'),
        headers.get('x-request-context'),
      ].join(' ')
    }
    const messages: string[] = []
    for (const mode of ['network', 'http'] as const) {
      const provider = createOpenAiCompatibleProvider({
        baseUrl: `https://host.example/v1/${endpointSecret}?api_key=${endpointSecret}`,
        model: 'gpt-test',
        apiKey,
        headers: {
          'x-api-token': tokenHeader,
          cookie: `session=${cookieSecret}`,
          'x-request-context': visibleHeader,
        },
        retries: 0,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const detail = echoed(input, init)
          if (mode === 'network') throw new Error(detail)
          return new Response(detail, { status: 401 })
        }) as typeof fetch,
      })
      try {
        await provider.pick({ tools: [], prompt: 'x', temperature: 0 })
      } catch (cause) {
        messages.push(cause instanceof Error ? cause.message : String(cause))
      }
    }

    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message).not.toContain(endpointSecret)
      expect(message).not.toContain(apiKey)
      expect(message).not.toContain(tokenHeader)
      expect(message).not.toContain(cookieSecret)
      expect(message).toContain(visibleHeader)
    }
  })
})
