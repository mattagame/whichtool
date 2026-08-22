import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { toDisplayPath } from '../src/cli/paths.js'
import { createFakeRuntime, fixturePath, REPO_ROOT } from './helpers.js'
import { EXIT, main } from '../src/cli/run.js'

/**
 * Reports get committed and pasted into pull requests. An absolute path in one exposes a
 * home directory and a username to everyone who reads it, so nothing whichtool writes may
 * contain one.
 */
describe('toDisplayPath', () => {
  const runtime = createFakeRuntime({ cwd: REPO_ROOT })

  test('makes a path inside the working directory relative', () => {
    expect(toDisplayPath(runtime, join(REPO_ROOT, 'tests', 'fixtures', 'a.json'))).toBe(
      'tests/fixtures/a.json',
    )
  })

  test('always uses forward slashes, so two machines produce the same report', () => {
    expect(toDisplayPath(runtime, join(REPO_ROOT, 'a', 'b', 'c.json'))).toBe('a/b/c.json')
  })

  test('reduces a path outside the working directory to its file name', () => {
    // Walking out with `..` would climb through the home directory and leak exactly the
    // thing this function exists to hide, so the file name is all that survives.
    const outside = toDisplayPath(runtime, join(REPO_ROOT, '..', '..', 'elsewhere', 'run.json'))
    expect(outside).toBe('run.json')
    expect(outside).not.toContain('..')
  })

  test('leaves an already relative path alone', () => {
    expect(toDisplayPath(runtime, './tools.json')).toBe('./tools.json')
  })
})

describe('no absolute path reaches an artifact', () => {
  const tasks = join(REPO_ROOT, 'tests', 'fixtures', 'tasks', 'list-search.tasks.yaml')

  test('a saved run records the task set relative to the working directory', async () => {
    const runtime = createFakeRuntime({ cwd: REPO_ROOT })
    const code = await main(
      [
        'run',
        fixturePath('list-search-pair.json'),
        '--tasks',
        tasks,
        '--provider',
        'mock',
        '--repeat',
        '1',
        '--no-cache',
        '--format',
        'json',
      ],
      runtime,
    )
    expect(code).toBe(EXIT.ok)

    const report = JSON.parse(runtime.out()) as {
      reproducibility: { taskSetSource: string }
      target: { ref: string }
    }
    expect(report.reproducibility.taskSetSource).toBe('tests/fixtures/tasks/list-search.tasks.yaml')
    // The target was given as an absolute path; the report must not repeat it back.
    expect(report.target.ref).toBe('tests/fixtures/servers/list-search-pair.json')
    expect(runtime.out()).not.toContain(REPO_ROOT)
    expect(runtime.out()).not.toMatch(/[A-Za-z]:[\\/]Users/)
  })

  test('an inspection records the target relatively too', async () => {
    const runtime = createFakeRuntime({ cwd: REPO_ROOT })
    await main(['inspect', fixturePath('clean.json'), '--format', 'json'], runtime)
    const report = JSON.parse(runtime.out()) as { target: { ref: string } }
    expect(report.target.ref).toBe('tests/fixtures/servers/clean.json')
  })

  test('an absolute snapshot outside cwd is still read without exposing its path', async () => {
    const runtime = createFakeRuntime({ cwd: join(REPO_ROOT, 'examples') })
    const code = await main(['inspect', fixturePath('clean.json'), '--format', 'json'], runtime)
    const report = JSON.parse(runtime.out()) as { target: { ref: string } }

    expect(code).toBe(EXIT.ok)
    expect(report.target.ref).toBe('clean.json')
    expect(runtime.out()).not.toContain(REPO_ROOT)
  })

  test('the dry-run summary names the task set relatively', async () => {
    const runtime = createFakeRuntime({ cwd: REPO_ROOT })
    await main(
      ['run', fixturePath('list-search-pair.json'), '--tasks', tasks, '--dry-run'],
      runtime,
    )
    expect(runtime.out()).toContain('tests/fixtures/tasks/list-search.tasks.yaml')
    expect(runtime.out()).not.toContain(REPO_ROOT)
  })

  test('`tasks lint` prints a relative path', async () => {
    const runtime = createFakeRuntime({ cwd: REPO_ROOT })
    await main(['tasks', 'lint', '--tasks', tasks], runtime)
    expect(runtime.out()).toContain('tests/fixtures/tasks/list-search.tasks.yaml')
    expect(runtime.out()).not.toContain(REPO_ROOT)
  })

  test('the `--out` confirmation echoes the path as typed', async () => {
    const runtime = createFakeRuntime({ cwd: REPO_ROOT })
    await main(['inspect', fixturePath('clean.json'), '--out', 'report.txt'], runtime)
    expect(runtime.err()).toBe('Wrote terminal report to report.txt\n')
  })
})

/**
 * The committed artifacts are the ones that actually get published, and generated output is
 * where a machine path slips in unnoticed — nobody re-reads a regenerated golden file line
 * by line. So the check runs on every build rather than living in someone's memory.
 */
describe('committed artifacts carry no machine paths', () => {
  const HOME_PATH = /[A-Za-z]:[\\/]Users[\\/]|\/home\/[a-z]|\/Users\/[a-z]/

  function walk(directory: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) found.push(...walk(path))
      else found.push(path)
    }
    return found
  }

  for (const directory of [
    'examples',
    join('tests', 'golden'),
    join('tests', 'fixtures'),
    'docs',
  ]) {
    test(`${directory.replace(/\\/g, '/')} is free of absolute paths`, () => {
      const offenders = walk(join(REPO_ROOT, directory))
        .filter((path) => HOME_PATH.test(readFileSync(path, 'utf8')))
        .map((path) => path.slice(REPO_ROOT.length + 1))
      expect(offenders).toEqual([])
    })
  }
})
