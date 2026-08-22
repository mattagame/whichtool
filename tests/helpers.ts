import { readFileSync, statSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Runtime } from '../src/runtime/types.js'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE_SERVERS = join(REPO_ROOT, 'tests', 'fixtures', 'servers')

export function fixturePath(name: string): string {
  return join(FIXTURE_SERVERS, name)
}

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8'))
}

const DID_NOT_THROW = Symbol('did-not-throw')

/**
 * Await a promise that is expected to reject and return the error, typed.
 *
 * `promise.catch(cause => cause)` widens to `T | unknown`, which makes every assertion on
 * `.message` or `.hint` a type error.
 */
export async function caught(promise: Promise<unknown>): Promise<Error & { hint?: string }> {
  let outcome: unknown = DID_NOT_THROW
  try {
    await promise
  } catch (cause) {
    outcome = cause
  }
  if (outcome === DID_NOT_THROW) throw new Error('expected the call to reject, but it resolved')
  return outcome as Error & { hint?: string }
}

export interface FakeRuntime extends Runtime {
  /** Everything written to stdout, concatenated. */
  out(): string
  /** Everything written to stderr, concatenated. */
  err(): string
  /** Files the run wrote, by absolute path. */
  writes(): Map<string, string>
}

export interface FakeRuntimeOptions {
  /** In-memory files, keyed by the path the code will resolve. They shadow the real disk. */
  files?: Record<string, string>
  /** Final canonical paths for symlink/junction policy tests, keyed by resolved path. */
  realpaths?: Record<string, string>
  /** File-size overrides for bounded-read policy tests, keyed by resolved path. */
  fileSizes?: Record<string, number>
  env?: Record<string, string>
  isTTY?: boolean
  cwd?: string
  terminalWidth?: number
  /** Lines the MCP server should read, in order. The stream ends when they run out. */
  stdin?: readonly string[]
}

async function* stdinLines(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) yield line
}

/**
 * A `Runtime` that captures output instead of touching the process.
 *
 * Real files still resolve — the CLI tests point at the fixtures on disk — but anything in
 * `options.files` shadows them, and nothing is ever written to disk.
 */
export function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const cwd = options.cwd ?? REPO_ROOT
  const toAbsolute = (path: string): string => (isAbsolute(path) ? path : resolve(cwd, path))
  const files = new Map(
    Object.entries(options.files ?? {}).map(([key, value]) => [resolve(cwd, key), value]),
  )
  const realpaths = new Map(
    Object.entries(options.realpaths ?? {}).map(([key, value]) => [
      toAbsolute(key),
      toAbsolute(value),
    ]),
  )
  const fileSizes = new Map(
    Object.entries(options.fileSizes ?? {}).map(([key, value]) => [toAbsolute(key), value]),
  )
  const written = new Map<string, string>()
  const stdout: string[] = []
  const stderr: string[] = []

  return {
    name: 'node',
    async readTextFile(path) {
      const absolute = toAbsolute(path)
      const inMemory = files.get(absolute) ?? written.get(absolute)
      if (inMemory !== undefined) return inMemory
      return readFileSync(absolute, 'utf8')
    },
    async writeTextFile(path, content) {
      written.set(toAbsolute(path), content)
    },
    async fileExists(path) {
      const absolute = toAbsolute(path)
      if (files.has(absolute) || written.has(absolute)) return true
      try {
        readFileSync(absolute, 'utf8')
        return true
      } catch {
        return false
      }
    },
    async fileSize(path) {
      const absolute = toAbsolute(path)
      const overridden = fileSizes.get(absolute)
      if (overridden !== undefined) return overridden
      const inMemory = files.get(absolute) ?? written.get(absolute)
      return inMemory === undefined ? statSync(absolute).size : Buffer.byteLength(inMemory, 'utf8')
    },
    env(key) {
      return options.env?.[key]
    },
    cwd() {
      return cwd
    },
    resolve(...segments) {
      return resolve(cwd, ...segments)
    },
    async realpath(path) {
      const absolute = toAbsolute(path)
      return realpaths.get(absolute) ?? absolute
    },
    isStdoutTTY() {
      return options.isTTY ?? false
    },
    terminalWidth() {
      return options.terminalWidth
    },
    writeOut(text) {
      stdout.push(text)
    },
    writeErr(text) {
      stderr.push(text)
    },
    async importModule(absolutePath) {
      return import(absolutePath)
    },
    readStdinLines() {
      return stdinLines(options.stdin ?? [])
    },
    async spawnProcess(spec) {
      // The fake runtime never launches anything. A test that needs a stdio server builds
      // an `McpProcess` directly and hands it to `stdioTransportFromProcess`.
      throw new Error(`the fake runtime does not spawn processes (asked for: ${spec.command})`)
    },
    out: () => stdout.join(''),
    err: () => stderr.join(''),
    writes: () => written,
  }
}
