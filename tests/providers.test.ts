import { describe, expect, test } from 'bun:test'
import { createAnthropicProvider } from '../src/core/providers/anthropic.js'
import { createOpenAiCompatibleProvider } from '../src/core/providers/openai-compatible.js'
import { createOpenAiResponsesProvider } from '../src/core/providers/openai-responses.js'
import { createMockProvider } from '../src/core/providers/mock.js'
import { DEFAULT_RETRIES } from '../src/core/providers/http.js'
import { ProviderError } from '../src/core/providers/types.js'
import type { JsonObject, NormalizedTool } from '../src/core/types.js'
import { caught } from './helpers.js'

const SCHEMA = { type: 'object', properties: { limit: { type: 'number' } } } as const

const TOOLS: NormalizedTool[] = [
  {
    name: 'list_users',
    description: 'List the users in the workspace.',
    hasDescription: true,
    inputSchema: SCHEMA,
    inputSchemaResolved: SCHEMA,
    originalIndex: 0,
  },
]

/** A fetch stub that records the one request it receives and replies with `payload`. */
function stub(payload: JsonObject, status = 200) {
  const seen: { body: JsonObject; headers: Record<string, string>; url: string }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as JsonObject,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return new Response(JSON.stringify(payload), { status })
  }) as unknown as typeof fetch
  return { seen, fetchImpl }
}

function provider(payload: JsonObject, status = 200) {
  const { seen, fetchImpl } = stub(payload, status)
  return {
    seen,
    instance: createAnthropicProvider({
      model: 'claude-opus-5',
      apiKey: 'sk-ant-test',
      fetch: fetchImpl,
      retries: 0,
    }),
  }
}

const TOOL_USE_TURN: JsonObject = {
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'Listing them.' },
    { type: 'tool_use', id: 'toolu_1', name: 'list_users', input: { limit: 10 } },
  ],
  usage: { input_tokens: 412, output_tokens: 37 },
}

test('built-in HTTP providers do not retry paid requests unless explicitly configured', () => {
  expect(DEFAULT_RETRIES).toBe(0)
})

test('a transient HTTP failure makes one request by default', async () => {
  const { seen, fetchImpl } = stub({ error: { message: 'busy' } }, 503)
  const instance = createAnthropicProvider({
    model: 'claude-opus-5',
    apiKey: 'sk-ant-test',
    fetch: fetchImpl,
  })

  await caught(instance.pick({ tools: TOOLS, prompt: 'show me the users', temperature: 0 }))

  expect(seen).toHaveLength(1)
})

describe('the Anthropic provider speaks the Messages API, not a chat-completions dialect', () => {
  test('posts to /v1/messages with the version and key headers', async () => {
    const { seen, instance } = provider(TOOL_USE_TURN)
    await instance.pick({ tools: TOOLS, prompt: 'show me the users', temperature: 0 })

    expect(seen[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen[0]?.headers['x-api-key']).toBe('sk-ant-test')
    expect(seen[0]?.headers['anthropic-version']).toBe('2023-06-01')
    // Bearer is the OpenAI convention and is not what this endpoint reads.
    expect(seen[0]?.headers['authorization']).toBeUndefined()
  })

  test('declares tools flat, without the OpenAI function envelope', async () => {
    const { seen, instance } = provider(TOOL_USE_TURN)
    await instance.pick({ tools: TOOLS, prompt: 'show me the users', temperature: 0 })

    expect(seen[0]?.body['tools']).toEqual([
      {
        name: 'list_users',
        description: 'List the users in the workspace.',
        input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
      },
    ])
  })

  // The sampling parameters were removed on current Claude models and are answered with a
  // 400. Sending temperature 0 "for reproducibility" would fail every single trial.
  test('sends no temperature and no seed', async () => {
    const { seen, instance } = provider(TOOL_USE_TURN)
    await instance.pick({ tools: TOOLS, prompt: 'show me the users', temperature: 0, seed: 7 })

    expect(seen[0]?.body).not.toHaveProperty('temperature')
    expect(seen[0]?.body).not.toHaveProperty('seed')
    expect(seen[0]?.body['max_tokens']).toBeNumber()
  })

  test('says so in its capabilities rather than claiming a temperature it never applied', () => {
    const { instance } = provider(TOOL_USE_TURN)
    expect(instance.capabilities.temperatureZero).toBe(false)
    expect(instance.capabilities.seed).toBe(false)
  })

  // Forcing a call would make abstention impossible and destroy the over-trigger metric.
  test('leaves tool_choice unset, so abstention stays possible', async () => {
    const { seen, instance } = provider(TOOL_USE_TURN)
    await instance.pick({ tools: TOOLS, prompt: 'what is the weather?', temperature: 0 })

    expect(seen[0]?.body).not.toHaveProperty('tool_choice')
  })

  test('reads the pick from a tool_use block, whose input is already parsed', async () => {
    const { instance } = provider(TOOL_USE_TURN)
    const result = await instance.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 })

    expect(result.pick).toBe('list_users')
    expect(result.arguments).toEqual({ limit: 10 })
    expect(result.rawArguments).toBeUndefined()
    expect(result.text).toBe('Listing them.')
    expect(result.usage).toEqual({ promptTokens: 412, completionTokens: 37 })
  })

  test('records an abstention when the model answers with text alone', async () => {
    const { instance } = provider({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'No tool here fits that request.' }],
    })
    const result = await instance.pick({ tools: TOOLS, prompt: 'weather?', temperature: 0 })

    expect(result.pick).toBeNull()
    expect(result.callCount).toBe(0)
  })

  test('preserves every call while projecting the first through compatibility fields', async () => {
    const { instance } = provider({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'a', name: 'list_users', input: {} },
        { type: 'tool_use', id: 'b', name: 'count_users', input: {} },
      ],
    })
    const result = await instance.pick({ tools: TOOLS, prompt: 'both', temperature: 0 })

    expect(result.pick).toBe('list_users')
    expect(result.callCount).toBe(2)
    expect(result.calls).toEqual([
      { name: 'list_users', arguments: {} },
      { name: 'count_users', arguments: {} },
    ])
  })
})

describe('outcomes that are neither a pick nor an abstention are raised, not scored', () => {
  // Both of these arrive as HTTP 200 with a plausible-looking body. Scoring them as
  // abstentions would move the over-trigger and accuracy rates for a reason that has
  // nothing to do with the surface under test.
  test('a refusal is an error, not the model declining to call a tool', async () => {
    const { instance } = provider({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber' },
      content: [],
    })
    const error = await caught(
      instance.pick({ tools: TOOLS, prompt: 'delete the audit log', temperature: 0 }),
    )

    expect(error.message).toContain('declined')
    expect(error.message).toContain('cyber')
  })

  test('a turn truncated at max_tokens is an error, not an abstention', async () => {
    const { instance } = provider({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'I will call' }],
    })
    const error = await caught(instance.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }))

    expect(error.message).toContain('max_tokens')
    expect(error.hint).toContain('truncated turn')
  })

  test('a paused or malformed Messages turn is a provider error', async () => {
    const paused = provider({
      stop_reason: 'pause_turn',
      content: [{ type: 'text', text: 'Working...' }],
    }).instance
    const malformed = provider({
      stop_reason: 'end_turn',
      content: ['not a content block'],
    }).instance

    const pausedError = await caught(
      paused.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }),
    )
    const malformedError = await caught(
      malformed.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }),
    )
    expect(pausedError).toBeInstanceOf(ProviderError)
    expect(pausedError.message).toContain('pause_turn')
    expect(malformedError).toBeInstanceOf(ProviderError)
    expect(malformedError.message).toContain('malformed content block')
  })
})

describe('the OpenAI path guards the same two silent failures', () => {
  // Verified against openai/openai-openapi v2.3.0: a function name must match
  // `a-z A-Z 0-9 _ -` within 64 characters, and `finish_reason: "length"` means the turn
  // was cut off rather than answered.
  test('a turn truncated at the token limit is an error, not an abstention', async () => {
    const { fetchImpl } = stub({
      choices: [{ finish_reason: 'length', message: { content: 'I will call list_' } }],
    })
    const instance = createOpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'gpt-4.1',
      fetch: fetchImpl,
      retries: 0,
    })
    const error = await caught(instance.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }))

    expect(error.message).toContain('token limit')
    expect(error.hint).toContain('truncated turn')
  })

  test('rejects a provider response whose declared size exceeds the buffer limit', async () => {
    const fetchImpl = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(16 * 1024 * 1024 + 1) },
      })) as unknown as typeof fetch
    const instance = createOpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'gpt-4.1',
      fetch: fetchImpl,
      retries: 0,
    })
    const error = await caught(instance.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }))
    expect(error.message).toContain('larger than')
  })

  test('a chat refusal is a provider error, not an abstention', async () => {
    const { fetchImpl } = stub({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: null, refusal: 'I cannot help with that request.' },
        },
      ],
    })
    const instance = createOpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'gpt-4.1',
      fetch: fetchImpl,
      retries: 0,
    })

    const error = await caught(instance.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.message).toContain('declined')
  })

  test('a malformed chat envelope is a provider error, not an abstention', async () => {
    const { fetchImpl } = stub({
      choices: [{ message: { content: '', tool_calls: ['not a tool call'] } }],
    })
    const instance = createOpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'gpt-4.1',
      fetch: fetchImpl,
      retries: 0,
    })

    const error = await caught(instance.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.message).toContain('non-completed chat turn')
  })

  test('a 400 names the tools whose names OpenAI cannot accept', async () => {
    const dotted: NormalizedTool[] = [
      { ...(TOOLS[0] as NormalizedTool), name: 'issues.comment.add' },
    ]
    const { fetchImpl } = stub({ error: { message: 'Invalid value' } }, 400)
    const instance = createOpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'gpt-4.1',
      fetch: fetchImpl,
      retries: 0,
    })
    const error = await caught(
      instance.pick({ tools: dotted, prompt: 'add a comment', temperature: 0 }),
    )

    expect(error.hint).toContain('issues.comment.add')
    expect(error.hint).toContain('underscore')
  })

  test('preserves every chat-completions tool call, including malformed arguments', async () => {
    const { fetchImpl } = stub({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: '',
            tool_calls: [
              { function: { name: 'list_users', arguments: '{"limit":10}' } },
              { function: { name: 'count_users', arguments: '{not json' } },
            ],
          },
        },
      ],
    })
    const instance = createOpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'gpt-4.1',
      fetch: fetchImpl,
      retries: 0,
    })

    const result = await instance.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 })
    expect(result.pick).toBe('list_users')
    expect(result.arguments).toEqual({ limit: 10 })
    expect(result.callCount).toBe(2)
    expect(result.calls).toEqual([
      { name: 'list_users', arguments: { limit: 10 } },
      { name: 'count_users', arguments: null, rawArguments: '{not json' },
    ])
  })
})

const OPENAI_TURN: JsonObject = {
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: '',
        tool_calls: [{ function: { name: 'list_users', arguments: '{}' } }],
      },
    },
  ],
}

describe('a provider-side reasoning knob is part of what was measured', () => {
  test('reasoning_effort is sent when set, and absent when it is not', async () => {
    const withEffort = stub(OPENAI_TURN)
    await createOpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'gpt-5.6',
      fetch: withEffort.fetchImpl,
      retries: 0,
      reasoningEffort: 'none',
    }).pick({ tools: TOOLS, prompt: 'show me', temperature: 0 })
    expect(withEffort.seen[0]?.body['reasoning_effort']).toBe('none')

    const without = stub(OPENAI_TURN)
    await createOpenAiCompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'gpt-4.1',
      fetch: without.fetchImpl,
      retries: 0,
    }).pick({ tools: TOOLS, prompt: 'show me', temperature: 0 })
    expect(without.seen[0]?.body).not.toHaveProperty('reasoning_effort')
  })

  test('a 400 about reasoning_effort says which flag fixes it', async () => {
    const { fetchImpl } = stub(
      { error: { message: 'Function tools with reasoning_effort are not supported' } },
      400,
    )
    const error = await caught(
      createOpenAiCompatibleProvider({
        baseUrl: 'https://example.test/v1',
        model: 'gpt-5.6',
        fetch: fetchImpl,
        retries: 0,
      }).pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }),
    )
    expect(error.hint).toContain('--reasoning-effort none')
  })
})

describe('the native OpenAI provider speaks the Responses API', () => {
  const RESPONSE: JsonObject = {
    status: 'completed',
    output: [
      {
        type: 'function_call',
        name: 'list_users',
        arguments: '{"limit":10}',
        status: 'completed',
      },
    ],
    usage: { input_tokens: 123, output_tokens: 17 },
  }

  test('uses /responses and the flat function-tool shape', async () => {
    const { seen, fetchImpl } = stub(RESPONSE)
    const instance = createOpenAiResponsesProvider({
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-test',
      apiKey: 'sk-test',
      reasoningEffort: 'medium',
      fetch: fetchImpl,
      retries: 0,
    })

    const result = await instance.pick({
      tools: TOOLS,
      prompt: 'show me the users',
      temperature: 0,
    })

    expect(seen[0]?.url).toBe('https://api.openai.test/v1/responses')
    expect(seen[0]?.body['input']).toBe('show me the users')
    expect(seen[0]?.body['tool_choice']).toBe('auto')
    expect(seen[0]?.body['store']).toBe(false)
    expect(seen[0]?.body['reasoning']).toEqual({ effort: 'medium' })
    expect(seen[0]?.body['tools']).toEqual([
      {
        type: 'function',
        name: 'list_users',
        description: 'List the users in the workspace.',
        parameters: SCHEMA,
      },
    ])
    expect(result.pick).toBe('list_users')
    expect(result.arguments).toEqual({ limit: 10 })
    expect(result.callCount).toBe(1)
    expect(result.usage).toEqual({ promptTokens: 123, completionTokens: 17 })
  })

  test('reads generated text from message output items', async () => {
    const { fetchImpl } = stub({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '{"version":1,"tasks":[]}' }],
        },
      ],
    })
    const instance = createOpenAiResponsesProvider({
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-test',
      fetch: fetchImpl,
      retries: 0,
    })

    await expect(
      instance.generate?.({ prompt: 'draft tasks', temperature: 0, maxTokens: 200 }),
    ).resolves.toBe('{"version":1,"tasks":[]}')
  })

  test('does not score an incomplete response as abstention', async () => {
    const { fetchImpl } = stub({
      status: 'incomplete',
      output: [],
      incomplete_details: { reason: 'max_output_tokens' },
    })
    const instance = createOpenAiResponsesProvider({
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-test',
      fetch: fetchImpl,
      retries: 0,
    })

    const error = await caught(instance.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }))
    expect(error.message).toContain('max_output_tokens')
    expect(error.hint).toContain('not an abstention')
  })

  test('requires a completed Responses envelope instead of accepting a missing status', async () => {
    const { fetchImpl } = stub({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'No tool.' }] }],
    })
    const instance = createOpenAiResponsesProvider({
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-test',
      fetch: fetchImpl,
      retries: 0,
    })

    const error = await caught(instance.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.message).toContain('missing status')
  })

  test('raises Responses refusals and malformed output instead of scoring abstentions', async () => {
    const refused = createOpenAiResponsesProvider({
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-test',
      fetch: stub({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }],
      }).fetchImpl,
      retries: 0,
    })
    const malformed = createOpenAiResponsesProvider({
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-test',
      fetch: stub({ status: 'completed', output: ['not an output item'] }).fetchImpl,
      retries: 0,
    })

    const refusalError = await caught(
      refused.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }),
    )
    const malformedError = await caught(
      malformed.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 }),
    )
    expect(refusalError).toBeInstanceOf(ProviderError)
    expect(refusalError.message).toContain('declined')
    expect(malformedError).toBeInstanceOf(ProviderError)
    expect(malformedError.message).toContain('malformed output item')
  })

  test('preserves every Responses function_call in output order', async () => {
    const { fetchImpl } = stub({
      status: 'completed',
      output: [
        { type: 'function_call', name: 'list_users', arguments: '{}' },
        { type: 'function_call', name: 'count_users', arguments: '{"scope":"all"}' },
      ],
    })
    const result = await createOpenAiResponsesProvider({
      baseUrl: 'https://api.openai.test/v1',
      model: 'gpt-test',
      fetch: fetchImpl,
      retries: 0,
    }).pick({ tools: TOOLS, prompt: 'show me', temperature: 0 })

    expect(result.callCount).toBe(2)
    expect(result.calls).toEqual([
      { name: 'list_users', arguments: {} },
      { name: 'count_users', arguments: { scope: 'all' } },
    ])
  })
})

describe('the mock provider models complete call proposals', () => {
  test('uses calls as the authoritative source and keeps first-call compatibility fields', async () => {
    const instance = createMockProvider({
      script: [
        {
          pick: 'ignored_legacy_pick',
          calls: [
            { name: 'list_users', arguments: { limit: 5 } },
            { name: 'count_users', arguments: null, rawArguments: '{bad' },
          ],
        },
      ],
    })
    const result = await instance.pick({ tools: TOOLS, prompt: 'show me', temperature: 0 })

    expect(result.pick).toBe('list_users')
    expect(result.arguments).toEqual({ limit: 5 })
    expect(result.calls).toHaveLength(2)
    expect(result.callCount).toBe(result.calls.length)
  })
})
