import { describe, expect, test } from 'bun:test'
import {
  buildGenerationPrompt,
  extractJson,
  generateTaskSet,
  parseGeneratedTasks,
} from '../src/core/tasks/generate.js'
import { createKeywordProvider, createMockProvider } from '../src/core/providers/mock.js'
import { loadSurface } from '../src/core/surface/fetch.js'
import { snapshotTransportFromData } from '../src/core/transport/index.js'
import { EXIT, main } from '../src/cli/run.js'
import { createFakeRuntime, fixturePath, readFixture } from './helpers.js'
import type { Surface } from '../src/core/types.js'

async function surface(): Promise<Surface> {
  return loadSurface(
    snapshotTransportFromData(readFixture('list-search-pair.json'), 'list-search-pair.json'),
  )
}

const GOOD_REPLY = JSON.stringify({
  tasks: [
    {
      id: 'users.list.a',
      prompt: 'Show me everyone in the workspace',
      expected: 'list_users',
      tags: ['read'],
    },
    {
      id: 'users.search.a',
      prompt: 'Find the person called Rossi',
      expected: 'search_users',
      tags: ['read'],
    },
    {
      id: 'users.get.a',
      prompt: 'Open the record for U-4821',
      expected: 'get_user',
      tags: ['read'],
    },
    {
      id: 'users.count.a',
      prompt: 'How big is this workspace?',
      expected: 'count_users',
      tags: ['read'],
    },
    {
      id: 'distractor.remove',
      prompt: 'Remove Rossi from the workspace for good',
      expected: null,
      tags: ['distractor'],
    },
  ],
})

describe('the generation prompt', () => {
  test('describes every tool with its parameters', async () => {
    const prompt = buildGenerationPrompt((await surface()).tools)
    expect(prompt).toContain('list_users')
    expect(prompt).toContain('search_users')
    expect(prompt).toContain('query (required)')
  })

  test('tells the model what a weak distractor looks like', async () => {
    const prompt = buildGenerationPrompt((await surface()).tools)
    // The single easiest way to get a meaningless over-trigger rate is an off-topic
    // distractor, so the prompt names the failure mode rather than hoping.
    expect(prompt).toContain("plausible within this server's subject matter")
    expect(prompt).toContain('What is the weather?')
  })

  test('honours the requested counts', async () => {
    const prompt = buildGenerationPrompt((await surface()).tools, {
      tasksPerTool: 7,
      distractors: 2,
    })
    expect(prompt).toContain('Write 7 natural-language requests')
    expect(prompt).toContain('plus 2 distractors')
  })
})

describe('extractJson', () => {
  test('reads a bare object', () => {
    expect(extractJson('{"tasks":[]}')).toEqual({ tasks: [] })
  })

  test('reads a fenced object', () => {
    expect(extractJson('```json\n{"tasks":[]}\n```')).toEqual({ tasks: [] })
  })

  test('reads an object preceded by prose, which models add anyway', () => {
    expect(extractJson('Sure! Here you go:\n{"tasks":[]}\nHope that helps.')).toEqual({ tasks: [] })
  })

  test('quotes what it got when there is no JSON at all', () => {
    expect(() => extractJson('I am afraid I cannot do that')).toThrow(/no JSON object/)
  })
})

describe('parseGeneratedTasks', () => {
  test('accepts a well-formed reply', async () => {
    const parsed = parseGeneratedTasks(JSON.parse(GOOD_REPLY), await surface())
    expect(parsed.tasks).toHaveLength(5)
    expect(parsed.tasks.filter((task) => task.expected === null)).toHaveLength(1)
    expect(parsed.diagnostics.filter((d) => d.severity === 'warning')).toEqual([])
  })

  test('drops a task that expects a tool the server does not have, and says why', async () => {
    const parsed = parseGeneratedTasks(
      { tasks: [{ id: 'a', prompt: 'p', expected: 'delete_users', tags: [] }] },
      await surface(),
    )
    expect(parsed.tasks).toEqual([])
    expect(parsed.diagnostics.map((d) => d.code)).toContain('generate/invented-tool')
  })

  test('keeps the good tasks when only some are bad', async () => {
    const parsed = parseGeneratedTasks(
      {
        tasks: [
          { id: 'a', prompt: 'Show everyone', expected: 'list_users', tags: [] },
          { id: 'b', prompt: 'x', expected: 'nope', tags: [] },
          { prompt: '', expected: null },
        ],
      },
      await surface(),
    )
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.diagnostics.length).toBeGreaterThan(1)
  })

  test('drops a repeated prompt', async () => {
    const parsed = parseGeneratedTasks(
      {
        tasks: [
          { id: 'a', prompt: 'Show everyone', expected: 'list_users', tags: [] },
          { id: 'b', prompt: 'show everyone', expected: 'list_users', tags: [] },
        ],
      },
      await surface(),
    )
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.diagnostics.map((d) => d.code)).toContain('generate/duplicate-prompt')
  })

  test('makes a duplicate id unique instead of throwing the task away', async () => {
    const parsed = parseGeneratedTasks(
      {
        tasks: [
          { id: 'same', prompt: 'Show everyone', expected: 'list_users', tags: [] },
          { id: 'same', prompt: 'Find Rossi', expected: 'search_users', tags: [] },
        ],
      },
      await surface(),
    )
    expect(parsed.tasks).toHaveLength(2)
    expect(new Set(parsed.tasks.map((task) => task.id)).size).toBe(2)
  })

  test('tags a distractor as one even when the model forgot', async () => {
    const parsed = parseGeneratedTasks(
      { tasks: [{ id: 'a', prompt: 'Delete Rossi', expected: null }] },
      await surface(),
    )
    expect(parsed.tasks[0]?.tags).toContain('distractor')
  })

  test('warns when tools were left uncovered', async () => {
    const parsed = parseGeneratedTasks(
      { tasks: [{ id: 'a', prompt: 'Show everyone', expected: 'list_users', tags: [] }] },
      await surface(),
    )
    expect(parsed.diagnostics.map((d) => d.code)).toContain('generate/uncovered-tools')
  })

  test('warns when no distractor was produced, because the run then measures less', async () => {
    const parsed = parseGeneratedTasks(
      { tasks: [{ id: 'a', prompt: 'Show everyone', expected: 'list_users', tags: [] }] },
      await surface(),
    )
    expect(parsed.diagnostics.map((d) => d.code)).toContain('generate/no-distractors')
  })

  test('refuses a reply with no tasks array', async () => {
    await expect(async () => parseGeneratedTasks({ nope: 1 }, await surface())).toThrow(
      /no `tasks` array/,
    )
  })
})

describe('generateTaskSet', () => {
  test('produces a committed-shaped task set stamped with the surface hash', async () => {
    const provider = createMockProvider({ script: [], generate: GOOD_REPLY })
    const current = await surface()
    const result = await generateTaskSet(provider, current)

    expect(result.taskSet.version).toBe(1)
    expect(result.taskSet.surface).toBe(current.hash)
    expect(result.tasks).toHaveLength(5)
    expect(result.raw).toBe(GOOD_REPLY)
  })

  test('says plainly when the provider cannot generate text', async () => {
    // The keyword mock answers with tool calls only, which is a complete provider for
    // measuring but not for drafting.
    const provider = createKeywordProvider({})
    await expect(generateTaskSet(provider, await surface())).rejects.toThrow(
      /cannot produce free-form text/,
    )
  })

  test('asks at a non-zero temperature, because a task set wants varied phrasing', async () => {
    let seen = -1
    const provider = createMockProvider({
      script: [],
      generate: () => GOOD_REPLY,
    })
    const wrapped = {
      ...provider,
      generate: async (request: { prompt: string; temperature: number }) => {
        seen = request.temperature
        return GOOD_REPLY
      },
    }
    await generateTaskSet(wrapped, await surface())
    expect(seen).toBeGreaterThan(0)
  })
})

describe('the CLI', () => {
  test('`tasks generate` refuses to clobber an existing task set', async () => {
    const runtime = createFakeRuntime({
      files: { 'whichtool.tasks.yaml': 'version: 1\ntasks: []' },
    })
    const code = await main(
      ['tasks', 'generate', fixturePath('clean.json'), '--provider', 'mock'],
      runtime,
    )
    expect(code).toBe(EXIT.error)
    expect(runtime.err()).toContain('already exists')
    expect(runtime.err()).toContain('--force')
  })

  test('`tasks generate` requires an explicit override above six tools before reading credentials', async () => {
    const source = readFixture('clean.json') as { tools: unknown[] }
    const runtime = createFakeRuntime({
      files: {
        'seven-tools.json': JSON.stringify({
          tools: [
            ...source.tools,
            ...Array.from({ length: 3 }, (_, index) => ({
              name: `extra_${index + 1}`,
              description: `Handle extra workflow ${index + 1}.`,
              inputSchema: { type: 'object', properties: {} },
            })),
          ],
        }),
      },
    })
    const code = await main(
      ['tasks', 'generate', 'seven-tools.json', '--provider', 'openai', '--out', 'draft.yaml'],
      runtime,
    )

    expect(code).toBe(EXIT.error)
    expect(runtime.err()).toContain('7 tools')
    expect(runtime.err()).toContain('--max-tools 7')
    expect(runtime.err()).not.toContain('OPENAI_API_KEY')
    expect(runtime.writes().size).toBe(0)
  })

  test('`tasks mutate` will not write over the set it just read', async () => {
    const runtime = createFakeRuntime()
    const code = await main(
      ['tasks', 'mutate', '--tasks', fixturePath('../tasks/list-search.tasks.yaml')],
      runtime,
    )
    expect(code).toBe(EXIT.error)
    expect(runtime.err()).toContain('needs --out')
  })

  test('`tasks mutate` writes a seeded, larger task set', async () => {
    const runtime = createFakeRuntime()
    const code = await main(
      [
        'tasks',
        'mutate',
        '--tasks',
        fixturePath('../tasks/list-search.tasks.yaml'),
        '--out',
        'mutated.yaml',
        '--mutations',
        'typo,casual',
        '--seed',
        '3',
      ],
      runtime,
    )
    expect(code).toBe(EXIT.ok)
    expect(runtime.out()).toContain('typo')
    expect(runtime.out()).toContain('produced')

    const [, written] = [...runtime.writes().entries()][0] as [string, string]
    expect(written).toContain('derivedFrom')
    expect(written).toContain('mutated')
  })

  test('`tasks mutate` rejects an unknown mutation by name', async () => {
    const runtime = createFakeRuntime()
    const code = await main(
      [
        'tasks',
        'mutate',
        '--tasks',
        fixturePath('../tasks/list-search.tasks.yaml'),
        '--out',
        'x.yaml',
        '--mutations',
        'nonsense',
      ],
      runtime,
    )
    expect(code).toBe(EXIT.error)
    expect(runtime.err()).toContain('Unknown mutation')
  })

  test('the help lists every subcommand as available', async () => {
    const runtime = createFakeRuntime()
    await main(['--help'], runtime)
    expect(runtime.out()).not.toMatch(/\(not implemented yet\)/)
  })
})
