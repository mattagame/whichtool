import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { main } from '../src/cli/run.js'
import { MCP_MAX_AGENT_FILE_BYTES, MCP_MAX_INBOUND_LINE_CHARS } from '../src/cli/commands/mcp.js'
import {
  MCP_MAX_CONCURRENCY,
  MCP_MAX_REPEAT,
  MCP_SERVER_TOOLS,
} from '../src/core/mcp-server/tools.js'
import {
  MCP_PROTOCOL_VERSION,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
} from '../src/core/transport/mcp.js'
import type { McpProcess } from '../src/core/transport/types.js'
import {
  createFakeRuntime,
  fixturePath,
  readFixture,
  REPO_ROOT,
  type FakeRuntimeOptions,
} from './helpers.js'

const TASKS = join(REPO_ROOT, 'tests', 'fixtures', 'tasks', 'list-search.tasks.yaml')
const CONFIG_PATH = 'mcp-test.config.json'
const SAFE_CONFIG = JSON.stringify({
  target: { transport: 'snapshot', path: fixturePath('list-search-pair.json') },
  tasks: TASKS,
  provider: { name: 'mock' },
})
const SEVEN_TOOL_SURFACE = JSON.stringify({
  tools: [
    ...(readFixture('list-search-pair.json') as { tools: unknown[] }).tools,
    ...Array.from({ length: 3 }, (_, index) => ({
      name: `extra_${index + 1}`,
      description: `Handle distinct extra workflow ${index + 1}.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })),
  ],
})
const SEVEN_TOOL_CONFIG = JSON.stringify({
  target: { transport: 'snapshot', path: 'seven-tools.json' },
  tasks: TASKS,
  provider: { name: 'mock' },
})
const SEVEN_TOOL_FILES = {
  'seven-tools.json': SEVEN_TOOL_SURFACE,
  'seven-tools.config.json': SEVEN_TOOL_CONFIG,
}

interface Reply {
  jsonrpc: string
  id: number | null
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: Record<string, unknown> }
}

interface SessionOptions extends Pick<
  FakeRuntimeOptions,
  'cwd' | 'env' | 'realpaths' | 'fileSizes'
> {
  argv?: readonly string[]
  files?: Record<string, string>
}

/** Drive the server the way an agent does: raw requests in, raw replies out. */
async function session(requests: readonly Record<string, unknown>[], options: SessionOptions = {}) {
  const runtime = createFakeRuntime({
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env,
    files: { [CONFIG_PATH]: SAFE_CONFIG, ...options.files },
    realpaths: options.realpaths,
    fileSizes: options.fileSizes,
    stdin: requests.map((request) => JSON.stringify(request)),
  })
  const argv = options.argv ?? ['--config', CONFIG_PATH]
  const code = await main(['mcp', ...argv], runtime)
  const replies = runtime
    .out()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Reply)
  return { code, replies, stderr: runtime.err(), writes: runtime.writes() }
}

function call(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

function modernParams(extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    _meta: { [META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION },
  }
}

function resultById(replies: readonly Reply[], id: number): Record<string, unknown> {
  const reply = replies.find((candidate) => candidate.id === id)
  if (reply?.result === undefined) throw new Error(`no result for request ${id}`)
  return reply.result
}

function envelope(result: Record<string, unknown>) {
  return result['structuredContent'] as {
    schemaVersion: string
    ok: boolean
    summary: string
    data?: Record<string, unknown>
    error?: { code: string; message: string; hint?: string; detail?: Record<string, unknown> }
  }
}

describe('the MCP server protocol', () => {
  test('answers legacy initialize with a legacy revision it supports', async () => {
    const { replies } = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    ])
    expect(replies[0]?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'whichtool' },
    })
  })

  test('never returns the handshake-free 2026 revision from legacy initialize', async () => {
    const { replies } = await session([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION },
      },
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    ])
    expect(resultById(replies, 1)['protocolVersion']).toBe('2025-11-25')
    expect(resultById(replies, 2)['protocolVersion']).toBe('2025-11-25')
  })

  test('implements 2026 server/discover with capabilities, instructions and server metadata', async () => {
    const { replies } = await session([
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} },
    ])
    const result = resultById(replies, 1)
    expect(result['supportedVersions']).toEqual([MCP_PROTOCOL_VERSION])
    expect(result['capabilities']).toEqual({ tools: { listChanged: false } })
    expect(result['instructions']).toContain('inspect_surface')
    expect(result['resultType']).toBe('complete')
    expect((result['_meta'] as Record<string, unknown>)[META_SERVER_INFO]).toMatchObject({
      name: 'whichtool',
    })
  })

  test('stamps every successful modern response and keeps cache fields modern-only', async () => {
    const { replies } = await session([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: modernParams() },
      { jsonrpc: '2.0', id: 2, method: 'ping', params: modernParams() },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: modernParams({ name: 'no_such_tool' }),
      },
    ])
    for (const id of [1, 2, 3]) {
      const result = resultById(replies, id)
      expect(result['resultType']).toBe('complete')
      expect((result['_meta'] as Record<string, unknown>)[META_SERVER_INFO]).toBeDefined()
    }
    expect(resultById(replies, 1)['cacheScope']).toBe('private')
  })

  test('stamps modern protocol errors in their data envelope', async () => {
    const { replies } = await session([
      { jsonrpc: '2.0', id: 1, method: 'resources/list', params: modernParams() },
    ])
    expect(replies[0]?.error?.code).toBe(-32601)
    expect(
      (replies[0]?.error?.data?.['_meta'] as Record<string, unknown>)[META_SERVER_INFO],
    ).toBeDefined()
  })

  test('encodes tools/list in the legacy shape after initialize', async () => {
    const { replies } = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ])
    const result = resultById(replies, 2)
    expect(result['resultType']).toBeUndefined()
    expect(result['_meta']).toBeUndefined()
    expect(result['ttlMs']).toBeUndefined()
    expect((result['tools'] as unknown[]).length).toBe(MCP_SERVER_TOOLS.length)
  })

  test('never answers a notification', async () => {
    const { replies } = await session([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 1, method: 'ping' },
    ])
    expect(replies).toHaveLength(1)
    expect(replies[0]?.id).toBe(1)
  })

  test('publishes an outputSchema for every tool', async () => {
    const { replies } = await session([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: modernParams() },
    ])
    const tools = resultById(replies, 1)['tools'] as Array<Record<string, unknown>>
    expect(tools).toHaveLength(MCP_SERVER_TOOLS.length)
    expect(tools.every((tool) => tool['outputSchema'] !== undefined)).toBe(true)
    expect(
      tools
        .filter((tool) => ['inspect_surface', 'validate_task_file'].includes(String(tool['name'])))
        .every(
          (tool) => (tool['annotations'] as Record<string, unknown>)['readOnlyHint'] === false,
        ),
    ).toBe(true)
  })

  test('writes only JSON-RPC to stdout, and everything else to stderr', async () => {
    const { replies, stderr } = await session([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    expect(replies).toHaveLength(1)
    expect(stderr).toContain('MCP server on stdio')
  })

  test('rejects an oversized inbound line before parsing or dispatching it', async () => {
    const runtime = createFakeRuntime({ stdin: ['x'.repeat(MCP_MAX_INBOUND_LINE_CHARS + 1)] })
    expect(await main(['mcp'], runtime)).toBe(0)
    const reply = JSON.parse(runtime.out().trim()) as Reply
    expect(reply.id).toBeNull()
    expect(reply.error?.code).toBe(-32600)
    expect(reply.error?.message).toContain('character limit')
  })
})

describe('agent-facing MCP policy and result contracts', () => {
  test('does not auto-discover executable config from the working directory', async () => {
    const runtime = createFakeRuntime({
      cwd: REPO_ROOT,
      stdin: [JSON.stringify(call(1, 'inspect_surface', {}))],
      files: { 'whichtool.config.ts': 'throw new Error("must not execute")' },
    })
    let imported = false
    runtime.importModule = async () => {
      imported = true
      throw new Error('must not execute')
    }

    expect(await main(['mcp'], runtime)).toBe(0)
    expect(imported).toBe(false)
    const reply = JSON.parse(runtime.out().trim()) as Reply
    expect(envelope(reply.result as Record<string, unknown>).error?.code).toBe('target/missing')
  })

  test('accepts only an explicit data-only JSON config', async () => {
    const runtime = createFakeRuntime({ cwd: REPO_ROOT })
    expect(await main(['mcp', '--config', 'whichtool.config.ts'], runtime)).toBe(2)
    expect(runtime.err()).toContain('accepts JSON only')
  })

  test('--config selects the trusted target and tools need no target path', async () => {
    const alternate = JSON.stringify({
      target: { transport: 'snapshot', path: fixturePath('get-fetch-pair.json') },
      tasks: TASKS,
      provider: { name: 'mock' },
    })
    const { replies } = await session([call(1, 'inspect_surface', {})], {
      argv: ['--config', 'alternate.config.json'],
      files: { 'alternate.config.json': alternate },
    })
    const data = envelope(resultById(replies, 1)).data as {
      target: { ref: string }
      surface: { toolCount: number }
    }
    expect(data.target.ref).toContain('get-fetch-pair.json')
    expect(data.surface.toolCount).toBe(3)
  })

  test('rejects a target supplied by an agent by default', async () => {
    const { replies } = await session([
      call(1, 'inspect_surface', { target: fixturePath('clean.json') }),
    ])
    const result = resultById(replies, 1)
    expect(result['isError']).toBe(true)
    const structured = envelope(result)
    expect(structured.ok).toBe(false)
    expect(structured.error?.code).toBe('mcp/dynamic-target-disabled')
  })

  test('accepts a dynamic snapshot only after the explicit unsafe startup opt-in', async () => {
    const { replies } = await session(
      [call(1, 'inspect_surface', { target: fixturePath('get-fetch-pair.json') })],
      { argv: ['--config', CONFIG_PATH, '--allow-dynamic-targets'] },
    )
    expect(
      (envelope(resultById(replies, 1)).data as { surface: { toolCount: number } }).surface
        .toolCount,
    ).toBe(3)
  })

  test('keeps an opted-in dynamic snapshot inside the workspace', async () => {
    const { replies } = await session(
      [
        call(1, 'inspect_surface', {
          target: join(REPO_ROOT, '..', 'outside-tools.json'),
          transport: 'snapshot',
        }),
      ],
      { argv: ['--config', CONFIG_PATH, '--allow-dynamic-targets'] },
    )
    expect(envelope(resultById(replies, 1)).error?.code).toBe('mcp/path-outside-workspace')
  })

  test('rejects an opted-in dynamic snapshot whose canonical path escapes through a link', async () => {
    const link = join(REPO_ROOT, 'linked-tools.json')
    const outside = join(REPO_ROOT, '..', 'outside-tools.json')
    const { replies } = await session(
      [call(1, 'inspect_surface', { target: link, transport: 'snapshot' })],
      {
        argv: ['--config', CONFIG_PATH, '--allow-dynamic-targets'],
        realpaths: { [link]: outside },
      },
    )
    expect(envelope(resultById(replies, 1)).error?.code).toBe('mcp/path-outside-workspace')
  })

  test('inspect_surface returns a versioned envelope with the parsed report', async () => {
    const { replies } = await session([call(1, 'inspect_surface', {})])
    const structured = envelope(resultById(replies, 1))
    expect(structured.schemaVersion).toBe('whichtool.mcp-result/1')
    expect(structured.ok).toBe(false)
    expect(structured.error).toBeUndefined()
    expect(structured.summary).toContain('4 tools')
    expect((structured.data as { surface: { toolCount: number } }).surface.toolCount).toBe(4)
  })

  test('validate_task_file defaults to configured tasks and surface', async () => {
    const { replies } = await session([call(1, 'validate_task_file', {})])
    const data = envelope(resultById(replies, 1)).data as {
      ok: boolean
      surfaceChecked: boolean
    }
    expect(data.ok).toBe(true)
    expect(data.surfaceChecked).toBe(true)
  })

  test('agent-selected file inputs cannot escape the working-directory allowlist', async () => {
    const { replies } = await session([
      call(1, 'validate_task_file', { tasks: join(REPO_ROOT, '..', 'outside.tasks.json') }),
    ])
    expect(envelope(resultById(replies, 1)).error?.code).toBe('mcp/path-outside-workspace')
  })

  test('agent-selected task files cannot escape through a symlink or junction', async () => {
    const link = join(REPO_ROOT, 'linked.tasks.yaml')
    const outside = join(REPO_ROOT, '..', 'outside.tasks.yaml')
    const { replies } = await session([call(1, 'validate_task_file', { tasks: link })], {
      realpaths: { [link]: outside },
    })
    expect(envelope(resultById(replies, 1)).error?.code).toBe('mcp/path-outside-workspace')
  })

  test('caps every kind of agent-selected file before reading it', async () => {
    const taskFile = join(REPO_ROOT, 'oversized.tasks.yaml')
    const snapshotFile = join(REPO_ROOT, 'oversized-tools.json')
    const runFile = join(REPO_ROOT, 'oversized-run.json')
    const tooLarge = MCP_MAX_AGENT_FILE_BYTES + 1
    const { replies } = await session(
      [
        call(1, 'validate_task_file', { tasks: taskFile }),
        call(2, 'inspect_surface', { target: snapshotFile, transport: 'snapshot' }),
        call(3, 'diff_saved_results', { base: runFile, head: runFile }),
      ],
      {
        argv: ['--config', CONFIG_PATH, '--allow-dynamic-targets'],
        files: {
          [taskFile]: 'version: 1\ntasks: []\n',
          [snapshotFile]: '{"tools":[]}',
          [runFile]: '{}',
        },
        fileSizes: {
          [taskFile]: tooLarge,
          [snapshotFile]: tooLarge,
          [runFile]: tooLarge,
        },
      },
    )
    for (const id of [1, 2, 3]) {
      expect(envelope(resultById(replies, id)).error?.code).toBe('mcp/file-too-large')
    }
  })

  test('a dry run returns the plan without requiring a provider call', async () => {
    const { replies } = await session([call(1, 'run_evaluation', { dryRun: true })])
    const structured = envelope(resultById(replies, 1))
    expect(structured.summary).toContain('No model was called')
    expect(structured.data).toMatchObject({
      trials: 50,
      maxTrials: 50,
      hardMaxTrials: 1000,
      withinTrialLimit: true,
      promptTokenEstimate: 'lower-bound',
    })
  })

  test('a real run is blocked with a machine-readable plan until the operator opts in', async () => {
    const { replies } = await session([call(1, 'run_evaluation', {})])
    const error = envelope(resultById(replies, 1)).error
    expect(error?.code).toBe('mcp/paid-run-disabled')
    expect(error?.detail?.['plan']).toMatchObject({ trials: 50 })
  })

  test('provider and model remain config-owned unless separately enabled', async () => {
    const { replies } = await session([
      call(1, 'run_evaluation', { dryRun: true, provider: 'openai', model: 'expensive' }),
    ])
    expect(envelope(resultById(replies, 1)).error?.code).toBe('mcp/provider-override-disabled')

    const enabled = await session(
      [call(2, 'run_evaluation', { dryRun: true, provider: 'mock', model: 'mock-override' })],
      { argv: ['--config', CONFIG_PATH, '--allow-provider-overrides'] },
    )
    expect(envelope(resultById(enabled.replies, 2)).data?.['provider']).toEqual({
      name: 'mock',
      model: 'mock-override',
      reasoningEffort: null,
    })
  })

  test('enforces repeat and concurrency limits even for raw clients that ignore JSON Schema', async () => {
    const { replies } = await session([
      call(1, 'run_evaluation', { dryRun: true, repeat: MCP_MAX_REPEAT + 1 }),
      call(2, 'run_evaluation', { dryRun: true, concurrency: MCP_MAX_CONCURRENCY + 1 }),
    ])
    expect(envelope(resultById(replies, 1)).error?.code).toBe('mcp/limit-exceeded')
    expect(envelope(resultById(replies, 2)).error?.code).toBe('mcp/limit-exceeded')
  })

  test('keeps the real-run budget operator-owned while allowing a safe preview', async () => {
    const preview = await session([call(1, 'run_evaluation', { dryRun: true, repeat: 6 })])
    expect(envelope(resultById(preview.replies, 1)).data).toMatchObject({
      trials: 60,
      maxTrials: 50,
      withinTrialLimit: false,
    })

    const blocked = await session([call(2, 'run_evaluation', { repeat: 6 })], {
      argv: ['--config', CONFIG_PATH, '--allow-paid-runs'],
    })
    expect(envelope(resultById(blocked.replies, 2)).error).toMatchObject({
      code: 'mcp/trial-limit',
      detail: { plan: { trials: 60, maxTrials: 50, withinTrialLimit: false } },
    })

    const allowed = await session([call(3, 'run_evaluation', { repeat: 6 })], {
      argv: ['--config', CONFIG_PATH, '--allow-paid-runs', '--max-trials', '60'],
    })
    expect(envelope(resultById(allowed.replies, 3)).data).toMatchObject({ trialCount: 60 })
  })

  test('keeps the cautious tool limit operator-owned while allowing a safe preview', async () => {
    const preview = await session([call(1, 'run_evaluation', { dryRun: true, repeat: 1 })], {
      argv: ['--config', 'seven-tools.config.json'],
      files: SEVEN_TOOL_FILES,
    })
    expect(envelope(resultById(preview.replies, 1)).data).toMatchObject({
      trials: 10,
      tools: 7,
      maxTools: 6,
      withinToolLimit: false,
    })

    const blocked = await session([call(2, 'run_evaluation', { repeat: 1 })], {
      argv: ['--config', 'seven-tools.config.json', '--allow-paid-runs'],
      files: SEVEN_TOOL_FILES,
    })
    expect(envelope(resultById(blocked.replies, 2)).error).toMatchObject({
      code: 'mcp/tool-limit',
      detail: { plan: { tools: 7, maxTools: 6, withinToolLimit: false } },
    })

    const allowed = await session([call(3, 'run_evaluation', { repeat: 1 })], {
      argv: ['--config', 'seven-tools.config.json', '--allow-paid-runs', '--max-tools', '7'],
      files: SEVEN_TOOL_FILES,
    })
    expect(envelope(resultById(allowed.replies, 3)).data).toMatchObject({ trialCount: 10 })
  })

  test('previews a plan above the absolute cap but never executes it', async () => {
    const tasks = Array.from({ length: 51 }, (_, index) => ({
      id: `large.${index}`,
      prompt: `List users for scenario ${index}`,
      expected: 'list_users',
      tags: [],
    }))
    const { replies } = await session(
      [
        call(1, 'run_evaluation', {
          tasks: 'large.tasks.json',
          repeat: MCP_MAX_REPEAT,
          dryRun: true,
        }),
        call(2, 'run_evaluation', {
          tasks: 'large.tasks.json',
          repeat: MCP_MAX_REPEAT,
        }),
      ],
      {
        argv: ['--config', CONFIG_PATH, '--allow-paid-runs'],
        files: { 'large.tasks.json': JSON.stringify({ version: 1, surface: null, tasks }) },
      },
    )
    expect(envelope(resultById(replies, 1)).data).toMatchObject({
      trials: 1020,
      hardMaxTrials: 1000,
      withinTrialLimit: false,
    })
    expect(envelope(resultById(replies, 2)).error?.code).toBe('mcp/limit-exceeded')
  })

  test('returns a compact summary and optionally stores the full report as an artifact', async () => {
    const { replies, writes } = await session([call(1, 'run_evaluation', { repeat: 1 })], {
      argv: ['--config', CONFIG_PATH, '--allow-paid-runs', '--result-file', 'latest-run.json'],
    })
    const data = envelope(resultById(replies, 1)).data as Record<string, unknown>
    expect(data['trialCount']).toBe(10)
    expect(data['trials']).toBeUndefined()
    expect(data['artifact']).toMatchObject({ kind: 'file', path: 'latest-run.json' })
    const stored = [...writes.entries()].find(([path]) => path.endsWith('latest-run.json'))?.[1]
    expect(JSON.parse(stored as string).trials).toHaveLength(10)
  })

  test('persistent caching is an operator opt-in in MCP mode', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'whichtool-mcp-cache-'))
    const cache = join(temporary, 'cache')
    try {
      await session([call(1, 'run_evaluation', { repeat: 1 })], {
        argv: ['--config', CONFIG_PATH, '--allow-paid-runs', '--cache-dir', cache],
      })
      expect(existsSync(join(cache, 'trials'))).toBe(false)

      await session([call(2, 'run_evaluation', { repeat: 1 })], {
        argv: ['--config', CONFIG_PATH, '--allow-paid-runs', '--cache', '--cache-dir', cache],
      })
      expect(existsSync(join(cache, 'trials'))).toBe(true)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test('tool failures are structured, actionable, and redact machine paths', async () => {
    const { replies, stderr } = await session(
      [call(1, 'inspect_surface', { target: './nowhere.json' })],
      { argv: ['--config', CONFIG_PATH, '--allow-dynamic-targets'] },
    )
    const result = resultById(replies, 1)
    const structured = envelope(result)
    expect(result['isError']).toBe(true)
    expect(structured.error?.code).toBeDefined()
    expect(JSON.stringify(structured)).not.toContain(REPO_ROOT)
    expect(JSON.stringify(structured)).not.toMatch(/[A-Za-z]:[\\/]Users/)
    expect(stderr).not.toMatch(/[A-Za-z]:[\\/]Users/)
  })

  test('an unknown tool names the ones that exist in a structured error', async () => {
    const { replies } = await session([call(1, 'no_such_tool', {})])
    const structured = envelope(resultById(replies, 1))
    expect(structured.error?.code).toBe('mcp/unknown-tool')
    expect(structured.error?.hint).toContain('inspect_surface')
  })

  test('closes a stdio transport when loading its malformed surface fails', async () => {
    let reply: string | null = null
    let closed = false
    const process: McpProcess = {
      async writeLine(line) {
        const request = JSON.parse(line) as { id: number }
        reply = JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { resultType: 'complete' },
        })
      },
      async nextLine() {
        const current = reply
        reply = null
        return current
      },
      stderrText: () => '',
      async close() {
        closed = true
      },
    }
    const runtime = createFakeRuntime({
      cwd: REPO_ROOT,
      stdin: [JSON.stringify(call(1, 'inspect_surface', { target: 'fake', transport: 'stdio' }))],
    })
    runtime.spawnProcess = async () => process
    await main(['mcp', '--allow-dynamic-targets'], runtime)
    expect(closed).toBe(true)
  })

  test('an unknown method is a JSON-RPC error, since it is a protocol fault', async () => {
    const { replies } = await session([{ jsonrpc: '2.0', id: 1, method: 'resources/list' }])
    expect(replies[0]?.error?.code).toBe(-32601)
  })

  test('unparseable input does not kill the session', async () => {
    const runtime = createFakeRuntime({
      cwd: REPO_ROOT,
      files: { [CONFIG_PATH]: SAFE_CONFIG },
      stdin: ['{ not json', '{"jsonrpc":"2.0","id":2,"method":"ping"}'],
    })
    await main(['mcp', '--config', CONFIG_PATH], runtime)
    const replies = runtime
      .out()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Reply)
    expect(replies).toHaveLength(2)
    expect(replies[0]?.error?.code).toBe(-32700)
    expect(replies[1]?.id).toBe(2)
  })

  test('exits cleanly when the client closes the stream', async () => {
    const { code } = await session([{ jsonrpc: '2.0', id: 1, method: 'ping' }])
    expect(code).toBe(0)
  })
})

describe('cancellation', () => {
  test('a cancellation notification is read while a request is still running', async () => {
    const runtime = createFakeRuntime({
      cwd: REPO_ROOT,
      files: { [CONFIG_PATH]: SAFE_CONFIG },
      stdin: [
        JSON.stringify(call(1, 'run_evaluation', { repeat: 5 })),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 1, reason: 'user asked' },
        }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      ],
    })
    await main(['mcp', '--config', CONFIG_PATH, '--allow-paid-runs'], runtime)

    const replies = runtime
      .out()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Reply)
    expect(replies.map((reply) => reply.id)).toEqual([2])
    expect(runtime.err()).toContain('cancelling request 1')
  })

  test('cancelling an id that is not running is ignored, not an error', async () => {
    const { replies } = await session([
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } },
      { jsonrpc: '2.0', id: 1, method: 'ping' },
    ])
    expect(replies).toHaveLength(1)
    expect(replies[0]?.id).toBe(1)
  })
})

describe('the runner honours an abort signal', () => {
  test('stops claiming trials once aborted and reports the partial run', async () => {
    const { planTrials } = await import('../src/core/eval/planner.js')
    const { runTrials } = await import('../src/core/eval/runner.js')
    const { createKeywordProvider } = await import('../src/core/providers/mock.js')
    const { loadSurface } = await import('../src/core/surface/fetch.js')
    const { snapshotTransportFromData } = await import('../src/core/transport/index.js')
    const { readFixture } = await import('./helpers.js')
    const { parseTaskSet } = await import('../src/core/tasks/load.js')
    const { readFileSync } = await import('node:fs')

    const surface = await loadSurface(
      snapshotTransportFromData(readFixture('list-search-pair.json'), 's'),
    )
    const taskSet = parseTaskSet(readFileSync(TASKS, 'utf8'), 't')
    const plan = planTrials(taskSet.tasks, surface.tools, { repeat: 5 })

    const controller = new AbortController()
    let seen = 0
    const provider = createKeywordProvider({ '': 'list_users' })
    const counting = {
      ...provider,
      pick: async (request: Parameters<typeof provider.pick>[0]) => {
        seen += 1
        if (seen === 3) controller.abort()
        return provider.pick(request)
      },
    }

    const executed = await runTrials(plan, taskSet.tasks, surface.tools, counting, {
      concurrency: 1,
      signal: controller.signal,
    })

    expect(executed.cancelled).toBe(true)
    expect(executed.outcomes.length).toBeLessThan(plan.trials.length)
    expect(executed.outcomes.every((outcome) => outcome !== undefined)).toBe(true)
  })
})
