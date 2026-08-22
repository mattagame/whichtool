import { WhichtoolError } from '../errors.js'
import {
  collectTools,
  parseJsonRpcMessage,
  type Implementation,
  type JsonRpcRequest,
  type ParsedMessage,
} from './mcp.js'
import type { ListToolsResult, McpProcess, SpawnSpec, Transport, TransportDeps } from './types.js'

/**
 * stdio transport (MCP 2026-07-28).
 *
 * The binding is newline-delimited JSON-RPC over the subprocess's standard streams, with
 * no handshake — the same per-request `_meta` the HTTP binding carries, minus the header
 * layer. Messages must not contain embedded newlines, which `JSON.stringify` guarantees.
 *
 * Responses and request-scoped notifications share one channel, so reading a reply means
 * reading until the `id` matches.
 */

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_LINE_CHARS = 16 * 1024 * 1024

export interface StdioTransportOptions {
  command: string
  args?: string[]
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  clientInfo?: Implementation | null
  timeoutMs?: number
}

export function splitCommandLine(commandLine: string): { command: string; args: string[] } {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false

  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index] as string

    if (char === '\\' && quote !== "'") {
      const next = commandLine[index + 1]
      if (next === '"' || next === "'" || next === '\\') {
        current += next
        hasToken = true
        index += 1
        continue
      }
    }
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      hasToken = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasToken) tokens.push(current)
      current = ''
      hasToken = false
      continue
    }
    current += char
    hasToken = true
  }

  if (quote !== null) {
    throw new WhichtoolError(
      'stdio/unbalanced-quote',
      `Unbalanced ${quote} quote in the target command line.`,
    )
  }
  if (hasToken) tokens.push(current)

  const [command, ...args] = tokens
  if (command === undefined) {
    throw new WhichtoolError('stdio/empty-command', 'The stdio target command line is empty.')
  }
  return { command, args }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause: unknown) => {
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      },
    )
  })
}

export function stdioTransportFromProcess(
  child: McpProcess,
  ref: string,
  options: { clientInfo?: Implementation | null; timeoutMs?: number } = {},
): Transport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const send = async (request: JsonRpcRequest): Promise<ParsedMessage> => {
    await child.writeLine(JSON.stringify(request))

    for (;;) {
      const line = await withTimeout(
        child.nextLine(),
        timeoutMs,
        () =>
          new WhichtoolError(
            'stdio/timeout',
            `\`${ref}\` did not answer tools/list within ${timeoutMs} ms.`,
            describeStderr(child),
          ),
      )

      if (line === null) {
        throw new WhichtoolError(
          'stdio/closed',
          `\`${ref}\` closed its output stream without answering tools/list.`,
          describeStderr(child),
        )
      }
      if (line.length > MAX_RESPONSE_LINE_CHARS) {
        throw new WhichtoolError(
          'stdio/response-too-large',
          `\`${ref}\` wrote a response longer than ${MAX_RESPONSE_LINE_CHARS} characters.`,
        )
      }
      const trimmed = line.trim()
      if (trimmed.length === 0) continue

      let payload: unknown
      try {
        payload = JSON.parse(trimmed)
      } catch {
        throw new WhichtoolError(
          'stdio/invalid-json',
          `\`${ref}\` wrote a line to stdout that is not valid JSON: ${trimmed.slice(0, 160)}`,
          'The spec forbids a server from writing anything to stdout that is not an MCP message; logging belongs on stderr.',
        )
      }

      const message = parseJsonRpcMessage(payload)
      // Notifications and replies to other ids share this channel; keep reading.
      if (message === null || message.notificationMethod !== undefined) continue
      if (message.id !== request.id) continue
      return message
    }
  }

  return {
    kind: 'stdio',
    ref,
    async listTools(): Promise<ListToolsResult> {
      return collectTools(send, ref, options.clientInfo)
    },
    async close() {
      await child.close()
    },
  }
}

function describeStderr(child: McpProcess): string | undefined {
  const stderr = child.stderrText().trim()
  if (stderr.length === 0) return undefined
  const tail = stderr.split('\n').slice(-5).join('\n')
  return `Last lines the server wrote to stderr (which is not itself an error signal):\n${tail}`
}

export async function createStdioTransport(
  options: StdioTransportOptions,
  deps: TransportDeps,
): Promise<Transport> {
  if (deps.spawn === undefined) {
    throw new WhichtoolError(
      'stdio/no-spawn',
      'This runtime cannot launch a subprocess, so the stdio transport is unavailable.',
    )
  }

  const parsed =
    options.args === undefined
      ? splitCommandLine(options.command)
      : { command: options.command, args: options.args }

  const spec: SpawnSpec = { command: parsed.command, args: parsed.args }
  if (options.cwd !== undefined) spec.cwd = options.cwd
  if (options.env !== undefined) spec.env = options.env

  const ref = [parsed.command, ...parsed.args].join(' ')
  let child: McpProcess
  try {
    child = await deps.spawn(spec)
  } catch (cause) {
    throw new WhichtoolError(
      'stdio/spawn-failed',
      `Cannot launch \`${ref}\`: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  const transportOptions: { clientInfo?: Implementation | null; timeoutMs?: number } = {}
  if (options.clientInfo !== undefined) transportOptions.clientInfo = options.clientInfo
  if (options.timeoutMs !== undefined) transportOptions.timeoutMs = options.timeoutMs
  return stdioTransportFromProcess(child, ref, transportOptions)
}
