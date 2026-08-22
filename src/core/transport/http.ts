import { WhichtoolError } from '../errors.js'
import { credentialHeaderValues, redactKnownHttpSecrets } from '../url-redaction.js'
import {
  collectTools,
  isModernMcpError,
  parseJsonRpcMessage,
  redactUrl,
  toolsListHttpHeaders,
  type Implementation,
  type JsonRpcRequest,
  type ParsedMessage,
} from './mcp.js'
import type { ListToolsResult, Transport } from './types.js'

/**
 * Streamable HTTP transport (MCP 2026-07-28).
 *
 * The revision is stateless: no `initialize` handshake, no `Mcp-Session-Id`, no standalone
 * GET stream. Every request is a self-contained POST carrying its protocol version and
 * capabilities in `_meta`, mirrored into routing headers. All of that lives in `mcp.ts`;
 * this file only moves bytes.
 */

const DEFAULT_TIMEOUT_MS = 30_000
/** Refuse to buffer an unbounded SSE stream from a hostile or broken server. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export interface HttpTransportOptions {
  url: string
  /** Extra headers, e.g. `Authorization`. Protocol headers cannot be overridden. */
  headers?: Record<string, string>
  fetch?: typeof fetch
  clientInfo?: Implementation | null
  timeoutMs?: number
}

function mergeHeaders(extra: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(extra ?? {})) headers[key.toLowerCase()] = value
  for (const [key, value] of Object.entries(toolsListHttpHeaders())) headers[key] = value
  return headers
}

export async function readSseResponse(
  body: ReadableStream<Uint8Array>,
  requestId: number,
  ref: string,
): Promise<ParsedMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let bytes = 0

  const consumeEvent = (block: string): ParsedMessage | null => {
    const data: string[] = []
    for (const line of block.split('\n')) {
      // A line starting with a colon is an SSE comment (used as a keep-alive).
      if (line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length === 0) return null

    let payload: unknown
    try {
      payload = JSON.parse(data.join('\n'))
    } catch {
      throw new WhichtoolError(
        'http/invalid-sse-event',
        `${ref} sent an SSE event whose data is not valid JSON.`,
      )
    }
    const message = parseJsonRpcMessage(payload)
    if (message === null) return null
    if (message.notificationMethod !== undefined) return null
    if (message.id !== requestId) return null
    return message
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value !== undefined) {
        bytes += value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) {
          throw new WhichtoolError(
            'http/response-too-large',
            `${ref} sent more than ${MAX_RESPONSE_BYTES} bytes on the tools/list stream.`,
          )
        }
        buffer += decoder.decode(value, { stream: true })
      }
      if (done) buffer += decoder.decode()

      buffer = buffer.replace(/\r\n/g, '\n')
      let separator = buffer.indexOf('\n\n')
      while (separator !== -1) {
        const block = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        const message = consumeEvent(block)
        if (message !== null) return message
        separator = buffer.indexOf('\n\n')
      }

      if (done) {
        // A stream that ends without a blank line after the last event is technically
        // malformed, but tolerating it costs nothing and servers do it.
        const message = buffer.trim().length > 0 ? consumeEvent(buffer) : null
        if (message !== null) return message
        throw new WhichtoolError(
          'http/stream-ended-early',
          `${ref} closed the tools/list stream without sending a response.`,
        )
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function readBoundedText(response: Response, ref: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new WhichtoolError(
      'http/response-too-large',
      `${ref} declared a response larger than ${MAX_RESPONSE_BYTES} bytes.`,
    )
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value !== undefined) {
        bytes += value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) {
          throw new WhichtoolError(
            'http/response-too-large',
            `${ref} sent more than ${MAX_RESPONSE_BYTES} bytes in one response.`,
          )
        }
        text += decoder.decode(value, { stream: true })
      }
      if (done) return text + decoder.decode()
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function redactBodyStrings(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactBodyStrings(item, redact))
  if (typeof value !== 'object' || value === null) return value

  const safe: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(safe, redact(key), {
      value: redactBodyStrings(child, redact),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return safe
}

async function readErrorBody(
  response: Response,
  ref: string,
  redact: (text: string) => string,
): Promise<unknown> {
  const text = await readBoundedText(response, ref)
  if (text.trim().length === 0) return undefined
  try {
    return redactBodyStrings(JSON.parse(text), redact)
  } catch {
    return redact(text)
  }
}

/**
 * Turn a non-2xx response into an error.
 *
 * The interesting case is telling a modern server that rejected us apart from a legacy
 * server that never spoke this revision. The spec's rule is exactly this: on 400, 404 or
 * 405, inspect the body — a recognized modern JSON-RPC error means the server is modern
 * and we should fix the request, not fall back.
 */
function errorForStatus(response: Response, body: unknown, ref: string): WhichtoolError {
  // A JSON-RPC error the spec does not define — an implementation-specific code. It is
  // still a modern server talking, so quote it rather than guessing at a legacy fallback.
  const parsed = parseJsonRpcMessage(body)
  if (parsed?.error !== undefined) {
    return new WhichtoolError(
      'http/error-response',
      `${ref} answered HTTP ${response.status} with JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`,
    )
  }

  if (response.status === 400 || response.status === 404 || response.status === 405) {
    return new WhichtoolError(
      'http/legacy-server-suspected',
      `${ref} answered HTTP ${response.status} with no recognisable MCP error.`,
      "That is the spec's signature of a server speaking the deprecated 2024-11-05 HTTP+SSE transport. whichtool does not implement that transport; point it at the server's Streamable HTTP endpoint, or capture a tools/list and use `--transport snapshot`.",
    )
  }

  const excerpt =
    typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body ?? null).slice(0, 200)
  return new WhichtoolError(
    'http/request-failed',
    `${ref} answered HTTP ${response.status} ${response.statusText}. ${excerpt}`,
    response.status === 401 || response.status === 403
      ? "Set an Authorization header: `WHICHTOOL_HTTP_AUTHORIZATION='Bearer ...' whichtool inspect <url>`."
      : undefined,
  )
}

/** Identify URL components that are unsafe places for credentials without echoing their value. */
const CREDENTIAL_LIKE = /^[A-Za-z0-9_-]{16,}$/

function credentialLikeParts(raw: string): string[] {
  try {
    const url = new URL(raw)
    const found = new Set<string>()
    if (url.username !== '' || url.password !== '') found.add('userinfo')
    for (const segment of url.pathname.split('/')) {
      if (CREDENTIAL_LIKE.test(segment) && /[0-9]/.test(segment)) {
        found.add('a token-like path segment')
      }
    }
    if (url.search !== '') found.add('query parameters')
    if (url.hash !== '') found.add('a fragment')
    return [...found]
  } catch {
    return []
  }
}
export function createHttpTransport(options: HttpTransportOptions): Transport {
  const ref = redactUrl(options.url)
  const doFetch = options.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new WhichtoolError(
      'http/no-fetch',
      'No global `fetch` is available. whichtool needs Node 20.11 or newer, or a Bun release.',
    )
  }
  const headers = mergeHeaders(options.headers)
  const credentials = credentialHeaderValues(headers)
  const redactErrorText = (text: string): string =>
    redactKnownHttpSecrets(text, options.url, ref, credentials)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // `null` means "deliberately do not identify ourselves"; `undefined` means "use the
  // default". Collapsing the two would make the opt-out impossible to express.

  const send = async (request: JsonRpcRequest): Promise<ParsedMessage> => {
    let response: Response
    try {
      response = await doFetch(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
        // Do not carry caller headers to an endpoint the caller did not name.
        redirect: 'error',
      })
    } catch (cause) {
      const message = redactErrorText(cause instanceof Error ? cause.message : String(cause))
      throw new WhichtoolError(
        'http/unreachable',
        `Cannot reach ${ref}: ${message}`,
        cause instanceof Error && cause.name === 'TimeoutError'
          ? `The server did not answer tools/list within ${timeoutMs} ms.`
          : undefined,
      )
    }

    if (!response.ok) {
      const body = await readErrorBody(response, ref, redactErrorText)
      const parsed = parseJsonRpcMessage(body)
      // A modern server signals unsupported version, missing capability and header
      // mismatch with HTTP 400 plus a JSON-RPC error; those get a precise message.
      if (parsed?.error !== undefined && isModernMcpError(body)) return parsed
      throw errorForStatus(response, body, ref)
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()

    if (contentType.includes('text/event-stream')) {
      if (response.body === null) {
        throw new WhichtoolError(
          'http/empty-stream',
          `${ref} announced an SSE response but sent no body.`,
        )
      }
      return readSseResponse(response.body, request.id, ref)
    }

    if (!contentType.includes('application/json')) {
      throw new WhichtoolError(
        'http/unexpected-content-type',
        `${ref} answered tools/list with \`Content-Type: ${contentType || '(none)'}\`.`,
        'The Streamable HTTP binding allows only `application/json` or `text/event-stream`.',
      )
    }

    let payload: unknown
    try {
      payload = JSON.parse(await readBoundedText(response, ref))
    } catch (cause) {
      if (cause instanceof WhichtoolError) throw cause
      throw new WhichtoolError(
        'http/invalid-json',
        `${ref} answered tools/list with a body that is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }

    const message = parseJsonRpcMessage(payload)
    if (message === null) {
      throw new WhichtoolError(
        'http/not-jsonrpc',
        `${ref} answered tools/list with something that is not a JSON-RPC message.`,
      )
    }
    if (message.id !== request.id) {
      throw new WhichtoolError(
        'http/id-mismatch',
        `${ref} answered request id ${request.id} with a message for id ${String(message.id)}.`,
      )
    }
    return message
  }

  return {
    kind: 'http',
    ref,
    async listTools(): Promise<ListToolsResult> {
      const result = await collectTools(send, ref, options.clientInfo)
      const exposed = credentialLikeParts(options.url)
      if (exposed.length > 0) {
        result.diagnostics.push({
          code: 'http/credential-in-url',
          severity: 'warning',
          message:
            'The target URL carries a value that looks like a credential (' +
            exposed.join(', ') +
            '). whichtool redacts it from artifacts and errors, but URLs can still reach ' +
            'upstream access logs. Move secrets to an Authorization header.',
        })
      }
      return result
    },
  }
}
