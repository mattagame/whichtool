import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile, realpath as resolveRealPath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import type { McpProcess, SpawnSpec } from '../core/transport/types.js'
import type { Runtime } from './types.js'

const SHUTDOWN_GRACE_MS = 2_000
const MAX_STDOUT_LINE_CHARS = 16 * 1024 * 1024
const MAX_BUFFERED_STDOUT_LINES = 1024
const MAX_STDERR_CHARS = 64 * 1024

/**
 * Environment names needed to locate and run ordinary local MCP commands. Everything else
 * (notably provider/API credentials) stays out unless the target config passes it explicitly.
 */
const CHILD_ENV_ALLOWLIST = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
])

export function minimalChildEnvironment(
  parent: NodeJS.ProcessEnv = process.env,
  explicit: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && CHILD_ENV_ALLOWLIST.has(key.toUpperCase())) environment[key] = value
  }
  for (const [key, value] of Object.entries(explicit)) {
    // Windows treats names case-insensitively. Remove an inherited `Path` before applying an
    // explicit `PATH`, so the caller's value wins on every platform.
    for (const inherited of Object.keys(environment)) {
      if (inherited !== key && inherited.toUpperCase() === key.toUpperCase()) {
        delete environment[inherited]
      }
    }
    environment[key] = value
  }
  return environment
}

export async function spawnMcpProcess(spec: SpawnSpec): Promise<McpProcess> {
  const child = spawn(spec.command, spec.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    env: minimalChildEnvironment(process.env, spec.env),
  })

  const lines: string[] = []
  const waiters: Array<(line: string | null) => void> = []
  let stdoutBuffer = ''
  let stderrText = ''
  let ended = false
  let spawnError: Error | null = null

  const push = (line: string): void => {
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(line)
    else {
      lines.push(line)
      if (lines.length > MAX_BUFFERED_STDOUT_LINES) {
        spawnError = new Error(
          `MCP subprocess buffered more than ${MAX_BUFFERED_STDOUT_LINES} stdout messages.`,
        )
        lines.length = 0
        child.kill()
        finish()
      }
    }
  }
  const finish = (): void => {
    if (ended) return
    ended = true
    if (stdoutBuffer.length > 0) {
      const remainder = stdoutBuffer
      stdoutBuffer = ''
      push(remainder)
    }
    while (waiters.length > 0) (waiters.shift() as (line: string | null) => void)(null)
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS) {
      stdoutBuffer = ''
      spawnError = new Error(
        `MCP subprocess wrote a stdout line longer than ${MAX_STDOUT_LINE_CHARS} characters.`,
      )
      child.kill()
      finish()
      return
    }
    let newline = stdoutBuffer.indexOf('\n')
    while (newline !== -1) {
      push(stdoutBuffer.slice(0, newline).replace(/\r$/, ''))
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      newline = stdoutBuffer.indexOf('\n')
    }
  })
  child.stdout.on('end', finish)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrText = `${stderrText}${chunk}`.slice(-MAX_STDERR_CHARS)
  })
  child.on('error', (cause: Error) => {
    spawnError = cause
    finish()
  })
  child.on('close', finish)

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', (cause: Error) => reject(cause))
  })

  return {
    async writeLine(line) {
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${line}\n`, (cause) => (cause ? reject(cause) : resolve()))
      })
    },
    async nextLine() {
      const buffered = lines.shift()
      if (buffered !== undefined) return buffered
      if (ended) {
        if (spawnError !== null) throw spawnError
        return null
      }
      return new Promise<string | null>((resolve) => waiters.push(resolve))
    },
    stderrText() {
      return stderrText
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return
      // The spec's shutdown sequence: close stdin, wait, then terminate.
      child.stdin.end()
      const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
      const timer = setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS)
      await exited
      clearTimeout(timer)
    },
  }
}

/**
 * The Node runtime. Also the fallback the Bun runtime delegates to, since Bun implements
 * the `node:` builtins — only the handful of calls where `Bun.*` is genuinely better are
 * overridden there.
 */
export function createNodeRuntime(name: 'bun' | 'node' = 'node'): Runtime {
  return {
    name,
    async readTextFile(path) {
      return readFile(path, 'utf8')
    },
    async writeTextFile(path, content) {
      await writeFile(path, content, 'utf8')
    },
    async fileExists(path) {
      try {
        const info = await stat(path)
        return info.isFile()
      } catch {
        return false
      }
    },
    async fileSize(path) {
      return (await stat(path)).size
    },
    env(key) {
      return process.env[key]
    },
    cwd() {
      return process.cwd()
    },
    resolve(...segments) {
      return resolvePath(process.cwd(), ...segments)
    },
    async realpath(path) {
      return resolveRealPath(path)
    },
    isStdoutTTY() {
      return process.stdout.isTTY === true
    },
    terminalWidth() {
      const columns = process.stdout.columns
      return typeof columns === 'number' && columns > 0 ? columns : undefined
    },
    writeOut(text) {
      process.stdout.write(text)
    },
    writeErr(text) {
      process.stderr.write(text)
    },
    async importModule(absolutePath) {
      const target = isAbsolute(absolutePath) ? absolutePath : resolvePath(absolutePath)
      return import(pathToFileURL(target).href)
    },
    spawnProcess: spawnMcpProcess,
    readStdinLines(): AsyncIterable<string> {
      // `createInterface` handles both line endings and split chunks, which matters because
      // a large tools/call payload rarely arrives in one read.
      return createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
    },
  }
}
