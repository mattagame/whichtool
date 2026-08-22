import { describe, expect, test } from 'bun:test'
import { EXIT, main } from '../src/cli/run.js'
import { INSPECT_SCHEMA_VERSION } from '../src/core/inspect.js'
import { WHICHTOOL_VERSION } from '../src/version.js'
import { applyEnvHeaders, AUTHORIZATION_ENV, AUTHORIZATION_ORIGIN_ENV } from '../src/cli/target.js'
import { createFakeRuntime, fixturePath } from './helpers.js'
import type { FakeRuntimeOptions } from './helpers.js'

const ANSI = /\[[0-9;]*m/

async function run(argv: string[], options: FakeRuntimeOptions = {}) {
  const runtime = createFakeRuntime(options)
  const code = await main(argv, runtime)
  return { code, out: runtime.out(), err: runtime.err(), writes: runtime.writes() }
}

describe('whichtool', () => {
  test('with no arguments it explains itself and succeeds', async () => {
    const { code, out } = await run([])
    expect(code).toBe(EXIT.ok)
    expect(out).toContain('whichtool <command>')
    expect(out).toContain('never executes a tool')
  })

  test('lists every command the CLI documents', async () => {
    const { out } = await run(['--help'])
    for (const command of [
      'inspect',
      'tasks lint',
      'tasks generate',
      'tasks mutate',
      'run',
      'diff',
      'report',
      'cache',
      'mcp',
    ]) {
      expect(out).toContain(command)
    }
    expect(out).not.toContain('not implemented yet')
  })

  test('reports its version', async () => {
    const { code, out } = await run(['--version'])
    expect(code).toBe(EXIT.ok)
    expect(out.trim()).toBe(WHICHTOOL_VERSION)
  })

  test('an unknown command exits 2 and says what to run instead', async () => {
    const { code, err } = await run(['frobnicate'])
    expect(code).toBe(EXIT.error)
    expect(err).toContain('Unknown command `frobnicate`')
    expect(err).toContain('--help')
  })

  test('an unknown subcommand exits 2 and names the real ones', async () => {
    const { code, err } = await run(['tasks', 'frobnicate'])
    expect(code).toBe(EXIT.error)
    expect(err).toContain('Unknown subcommand')
    expect(err).toContain('`tasks lint`')
    expect(err).toContain('`tasks mutate`')
  })
})

describe('whichtool inspect', () => {
  test('inspects a snapshot and exits 0', async () => {
    const { code, out } = await run(['inspect', fixturePath('clean.json')])
    expect(code).toBe(EXIT.ok)
    expect(out).toContain('whichtool inspect')
    expect(out).toContain('Context cost')
    expect(out).toContain('Annotations')
    expect(out).toContain('Lexical overlap')
    expect(out).toContain('No tool was executed.')
  })

  test('names the worst problem first', async () => {
    const { out } = await run(['inspect', fixturePath('copied-descriptions.json')])
    const worstFirst = out.indexOf('Worst first')
    expect(worstFirst).toBeGreaterThan(-1)
    expect(out.indexOf('descriptions/identical')).toBeGreaterThan(worstFirst)
  })

  test('emits a parseable, versioned JSON report', async () => {
    const { code, out } = await run(['inspect', fixturePath('clean.json'), '--format', 'json'])
    expect(code).toBe(EXIT.ok)
    const report = JSON.parse(out) as { schemaVersion: string; surface: { toolCount: number } }
    expect(report.schemaVersion).toBe(INSPECT_SCHEMA_VERSION)
    expect(report.surface.toolCount).toBe(4)
  })

  test('colours output on a terminal', async () => {
    const { out } = await run(['inspect', fixturePath('clean.json')], { isTTY: true })
    expect(out).toMatch(ANSI)
  })

  test('honours NO_COLOR even on a terminal', async () => {
    const { out } = await run(['inspect', fixturePath('clean.json')], {
      isTTY: true,
      env: { NO_COLOR: '1' },
    })
    expect(out).not.toMatch(ANSI)
  })

  test('degrades to plain text with no terminal', async () => {
    const { out } = await run(['inspect', fixturePath('clean.json')], { isTTY: false })
    expect(out).not.toMatch(ANSI)
  })

  test('--no-color wins over a terminal', async () => {
    const { out } = await run(['inspect', fixturePath('clean.json'), '--no-color'], { isTTY: true })
    expect(out).not.toMatch(ANSI)
  })

  test('exits 1 when the token budget is blown, not 0 and not 2', async () => {
    const { code, out } = await run([
      'inspect',
      fixturePath('bloated.json'),
      '--max-context-tokens',
      '100',
    ])
    expect(code).toBe(EXIT.thresholdViolated)
    expect(out).toContain('FAIL')
    expect(out).toContain('maxContextTokens')
  })

  test('exits 0 when the token budget is met', async () => {
    const { code } = await run([
      'inspect',
      fixturePath('clean.json'),
      '--max-context-tokens',
      '100000',
    ])
    expect(code).toBe(EXIT.ok)
  })

  test('writes to a file, uncoloured, and says where', async () => {
    const { code, writes, err } = await run(
      ['inspect', fixturePath('clean.json'), '--format', 'json', '--out', 'report.json'],
      { isTTY: true },
    )
    expect(code).toBe(EXIT.ok)
    expect(writes.size).toBe(1)
    const [path, content] = [...writes.entries()][0]!
    expect(path).toContain('report.json')
    expect(content).not.toMatch(ANSI)
    expect(err).toContain('Wrote json report to')
  })

  test('takes an origin-bound Authorization header from the environment', async () => {
    const spec = applyEnvHeaders({ transport: 'http', url: 'https://example.test/mcp' }, (key) => {
      if (key === AUTHORIZATION_ENV) return 'Bearer t0ken'
      if (key === AUTHORIZATION_ORIGIN_ENV) return 'https://example.test'
      return undefined
    })
    expect(spec).toMatchObject({ headers: { Authorization: 'Bearer t0ken' } })
  })

  test('refuses an environment credential without an exact allowed origin', async () => {
    expect(() =>
      applyEnvHeaders({ transport: 'http', url: 'https://example.test/mcp' }, (key) =>
        key === AUTHORIZATION_ENV ? 'Bearer t0ken' : undefined,
      ),
    ).toThrow(AUTHORIZATION_ORIGIN_ENV)

    expect(() =>
      applyEnvHeaders({ transport: 'http', url: 'https://other.test/mcp' }, (key) => {
        if (key === AUTHORIZATION_ENV) return 'Bearer t0ken'
        if (key === AUTHORIZATION_ORIGIN_ENV) return 'https://example.test'
        return undefined
      }),
    ).toThrow(/Refusing to send/)
  })

  test('never sends Authorization over plain HTTP to a remote host', async () => {
    expect(() =>
      applyEnvHeaders(
        { transport: 'http', url: 'http://example.test/mcp', headers: { Authorization: 'x' } },
        () => undefined,
      ),
    ).toThrow(/Use HTTPS/)
    expect(
      applyEnvHeaders(
        { transport: 'http', url: 'http://127.0.0.1:3000/mcp', headers: { Authorization: 'x' } },
        () => undefined,
      ),
    ).toMatchObject({ headers: { Authorization: 'x' } })
  })

  test('can explicitly suppress host credentials for an agent-supplied URL', async () => {
    const spec = applyEnvHeaders(
      { transport: 'http', url: 'https://example.test/mcp' },
      (key) => {
        if (key === AUTHORIZATION_ENV) return 'Bearer t0ken'
        if (key === AUTHORIZATION_ORIGIN_ENV) return 'https://example.test'
        return undefined
      },
      { allowAuthorization: false },
    )
    expect(JSON.stringify(spec)).not.toContain('t0ken')
  })

  test('an explicit header in the config wins over the environment', async () => {
    const spec = applyEnvHeaders(
      { transport: 'http', url: 'https://example.test/mcp', headers: { authorization: 'Basic x' } },
      () => 'Bearer t0ken',
    )
    expect(spec).toMatchObject({ headers: { authorization: 'Basic x' } })
    expect(JSON.stringify(spec)).not.toContain('t0ken')
  })

  test('a snapshot target is never given an Authorization header', async () => {
    const spec = applyEnvHeaders({ transport: 'snapshot', path: './x.json' }, () => 'Bearer t0ken')
    expect(JSON.stringify(spec)).not.toContain('t0ken')
  })

  test('refuses to guess what an unrecognisable target is', async () => {
    const { code, err } = await run(['inspect', 'bun run ./src/server.ts'])
    expect(code).toBe(EXIT.error)
    expect(err).toContain('Cannot tell what kind of target')
    expect(err).toContain('--transport stdio')
  })

  test('asks for a target when there is neither an argument nor a config', async () => {
    const { code, err } = await run(['inspect'])
    expect(code).toBe(EXIT.error)
    expect(err).toContain('No target given')
  })

  test('rejects a second target instead of silently ignoring it', async () => {
    const { code, err } = await run([
      'inspect',
      fixturePath('clean.json'),
      fixturePath('bloated.json'),
    ])
    expect(code).toBe(EXIT.error)
    expect(err).toContain('takes one target')
  })

  test('names the reporters that exist when asked for one that does not', async () => {
    // `html` is a run reporter; an inspection has no confusion matrix to navigate.
    const { code, err } = await run(['inspect', fixturePath('clean.json'), '--format', 'html'])
    expect(code).toBe(EXIT.error)
    expect(err).toContain('Available: terminal, json, markdown, junit, badge')
  })

  test('--save-snapshot writes what the server served, not the normalised view', async () => {
    const { code, writes } = await run([
      'inspect',
      fixturePath('jsonrpc-envelope.json'),
      '--save-snapshot',
      'captured.json',
    ])
    expect(code).toBe(EXIT.ok)

    const [, written] = [...writes.entries()][0] as [string, string]
    const parsed = JSON.parse(written) as { tools: Array<{ name: string }> }
    // The envelope is unwrapped, but the tools themselves are untouched: the file has to
    // stay readable by anything else that consumes a tools/list.
    expect(parsed.tools.map((tool) => tool.name)).toEqual(['get_weather', 'get_forecast'])
  })

  test('a saved snapshot reproduces the same surface hash offline', async () => {
    const first = await run(['inspect', fixturePath('clean.json'), '--format', 'json'])
    const captured = await run([
      'inspect',
      fixturePath('clean.json'),
      '--save-snapshot',
      'captured.json',
      '--format',
      'json',
    ])
    const a = JSON.parse(first.out) as { surface: { hash: string } }
    const b = JSON.parse(captured.out) as { surface: { hash: string } }
    expect(b.surface.hash).toBe(a.surface.hash)
  })

  test('inspect renders JUnit XML that parses', async () => {
    const { code, out } = await run([
      'inspect',
      fixturePath('list-search-pair.json'),
      '--format',
      'junit',
    ])
    expect(code).toBe(EXIT.thresholdViolated)
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(out).toContain('<testsuites name="whichtool"')
    expect(out).toContain('descriptions/identical')
  })

  test('inspect renders markdown and a badge', async () => {
    const markdown = await run(['inspect', fixturePath('clean.json'), '--format', 'markdown'])
    expect(markdown.code).toBe(EXIT.ok)
    expect(markdown.out).toContain('## whichtool inspect')

    const badge = await run(['inspect', fixturePath('clean.json'), '--format', 'badge'])
    const parsed = JSON.parse(badge.out) as { schemaVersion: number; message: string }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.message).toContain('4 tools')
  })

  test('rejects an unknown flag', async () => {
    const { code, err } = await run(['inspect', fixturePath('clean.json'), '--verbose'])
    expect(code).toBe(EXIT.error)
    expect(err).toContain('Unknown flag `--verbose`')
  })

  test('--help for the command lists its flags', async () => {
    const { code, out } = await run(['inspect', '--help'])
    expect(code).toBe(EXIT.ok)
    expect(out).toContain('--max-context-tokens')
    expect(out).toContain('never executes a tool')
  })

  test('reads the target and the token budget from a config file', async () => {
    const { code, out } = await run(['inspect'], {
      files: {
        'whichtool.config.json': JSON.stringify({
          target: { transport: 'snapshot', path: fixturePath('clean.json') },
          thresholds: { maxContextTokens: 100_000 },
        }),
      },
    })
    expect(code).toBe(EXIT.ok)
    expect(out).toContain('maxContextTokens')
  })

  test('a config-provided budget can fail the run', async () => {
    const { code } = await run(['inspect'], {
      files: {
        'whichtool.config.json': JSON.stringify({
          target: { transport: 'snapshot', path: fixturePath('bloated.json') },
          thresholds: { maxContextTokens: 50 },
        }),
      },
    })
    expect(code).toBe(EXIT.thresholdViolated)
  })

  test('the command-line budget overrides the config', async () => {
    const { code } = await run(['inspect', '--max-context-tokens', '1000000'], {
      files: {
        'whichtool.config.json': JSON.stringify({
          target: { transport: 'snapshot', path: fixturePath('bloated.json') },
          thresholds: { maxContextTokens: 50 },
        }),
      },
    })
    expect(code).toBe(EXIT.ok)
  })
})

describe('everything the CLI prints stays pure ASCII', () => {
  // The golden tests cover the report renderers. Nothing covered the help text and the
  // error hints, which is where a `…` or a `§` survived the refactor: those land on
  // terminals and in CI logs that are not guaranteed to be UTF-8.
  const NON_ASCII = /[^\x00-\x7F]/

  const HELP_INVOCATIONS = [
    [],
    ['--help'],
    ['inspect', '--help'],
    ['run', '--help'],
    ['diff', '--help'],
    ['report', '--help'],
    ['tasks', 'lint', '--help'],
    ['tasks', 'generate', '--help'],
    ['tasks', 'mutate', '--help'],
    ['cache', '--help'],
    ['mcp', '--help'],
  ]

  for (const argv of HELP_INVOCATIONS) {
    test(`\`whichtool ${argv.join(' ')}\` is ASCII`, async () => {
      const { out, err } = await run(argv)
      expect(out.replace(ANSI, '')).not.toMatch(NON_ASCII)
      expect(err.replace(ANSI, '')).not.toMatch(NON_ASCII)
    })
  }

  const FAILING_INVOCATIONS = [
    ['diff'],
    ['report'],
    ['run', fixturePath('clean.json'), '--provider', 'anthropic'],
    ['inspect', '--transport', 'legacy-sse', 'https://example.com/sse'],
    ['run', fixturePath('clean.json'), '--format', 'nonsense'],
  ]

  for (const argv of FAILING_INVOCATIONS) {
    test(`the error for \`${argv.slice(0, 2).join(' ')}\` is ASCII`, async () => {
      const { out, err } = await run(argv)
      expect(out.replace(ANSI, '')).not.toMatch(NON_ASCII)
      expect(err.replace(ANSI, '')).not.toMatch(NON_ASCII)
    })
  }
})
