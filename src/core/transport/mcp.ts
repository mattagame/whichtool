import { WhichtoolError } from '../errors.js'
import { isJsonObject } from '../json.js'
import type { Diagnostic, JsonObject, JsonValue, RawTool } from '../types.js'
import { redactSensitiveUrl } from '../url-redaction.js'
import { WHICHTOOL_VERSION } from '../../version.js'

export const MCP_PROTOCOL_VERSION = '2026-07-28'

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

export const HEADER_PROTOCOL_VERSION = 'MCP-Protocol-Version'
export const HEADER_METHOD = 'Mcp-Method'

export const MCP_ERROR = {
  headerMismatch: -32020,
  missingRequiredClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const

const MODERN_ERROR_CODES = new Set<number>(Object.values(MCP_ERROR))

export interface Implementation {
  name: string
  version: string
}

export const WHICHTOOL_CLIENT_INFO: Implementation = {
  name: 'whichtool',
  version: WHICHTOOL_VERSION,
}

export const WHICHTOOL_CLIENT_CAPABILITIES: JsonObject = {}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: JsonObject
}

/** Build a `tools/list` request, `_meta` included. `cursor` continues a paginated list. */
export function buildToolsListRequest(
  id: number,
  cursor: string | undefined,
  clientInfo: Implementation | null = WHICHTOOL_CLIENT_INFO,
): JsonRpcRequest {
  const meta: JsonObject = {
    [META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
    [META_CLIENT_CAPABILITIES]: WHICHTOOL_CLIENT_CAPABILITIES,
  }
  if (clientInfo !== null) {
    meta[META_CLIENT_INFO] = { name: clientInfo.name, version: clientInfo.version }
  }
  const params: JsonObject = { _meta: meta }
  if (cursor !== undefined) params['cursor'] = cursor
  return { jsonrpc: '2.0', id, method: 'tools/list', params }
}

export function toolsListHttpHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',

    accept: 'application/json, text/event-stream',
    [HEADER_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
    [HEADER_METHOD]: 'tools/list',
  }
}

export interface JsonRpcError {
  code: number
  message: string
  data?: JsonValue
}

export interface ParsedMessage {
  id: number | string | null
  result?: JsonObject
  error?: JsonRpcError

  notificationMethod?: string
}

export function parseJsonRpcMessage(payload: unknown): ParsedMessage | null {
  if (!isJsonObject(payload)) return null
  const method = payload['method']
  const id = payload['id']

  if (typeof method === 'string' && id === undefined) {
    return { id: null, notificationMethod: method }
  }

  const parsed: ParsedMessage = {
    id: typeof id === 'number' || typeof id === 'string' ? id : null,
  }
  const result = payload['result']
  if (isJsonObject(result)) parsed.result = result
  const error = payload['error']
  if (isJsonObject(error) && typeof error['code'] === 'number') {
    parsed.error = {
      code: error['code'],
      message: typeof error['message'] === 'string' ? error['message'] : '(no message)',
      ...(error['data'] === undefined ? {} : { data: error['data'] }),
    }
  }
  return parsed
}

/** True when a body is a JSON-RPC error a 2026-07-28 server would produce. */
export function isModernMcpError(payload: unknown): boolean {
  const parsed = parseJsonRpcMessage(payload)
  return parsed?.error !== undefined && MODERN_ERROR_CODES.has(parsed.error.code)
}

export interface ToolsListPage {
  tools: RawTool[]
  nextCursor?: string

  ttlMs?: number

  cacheScope?: string

  resultType: string
  serverInfo?: Implementation
}

/**
 * Turn a `tools/list` result into a page.
 *
 * Anything malformed raises rather than degrading to an empty tool list: reporting "this
 * server exposes no tools" when the truth is "the response could not be read" would be the
 * most misleading output whichtool could produce.
 */
export function readToolsListResult(result: JsonObject, ref: string): ToolsListPage {
  const tools = result['tools']
  if (!Array.isArray(tools)) {
    throw new WhichtoolError(
      'mcp/malformed-tools-list',
      `${ref} returned a tools/list result with no \`tools\` array.`,
    )
  }

  const rawResultType = result['resultType']
  const resultType = typeof rawResultType === 'string' ? rawResultType : 'complete'
  if (resultType !== 'complete') {
    throw new WhichtoolError(
      'mcp/unexpected-result-type',
      `${ref} answered tools/list with \`resultType: "${resultType}"\`.`,
      resultType === 'input_required'
        ? 'A server must not ask for client input to list its tools; whichtool declares no client capabilities and cannot answer.'
        : undefined,
    )
  }

  const page: ToolsListPage = { tools: tools as RawTool[], resultType }

  const nextCursor = result['nextCursor']
  if (typeof nextCursor === 'string' && nextCursor.length > 0) page.nextCursor = nextCursor

  const ttlMs = result['ttlMs']
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs)) page.ttlMs = ttlMs

  const cacheScope = result['cacheScope']
  if (typeof cacheScope === 'string') page.cacheScope = cacheScope

  const meta = result['_meta']
  if (isJsonObject(meta)) {
    const serverInfo = meta[META_SERVER_INFO]
    if (isJsonObject(serverInfo) && typeof serverInfo['name'] === 'string') {
      page.serverInfo = {
        name: serverInfo['name'],
        version: typeof serverInfo['version'] === 'string' ? serverInfo['version'] : '',
      }
    }
  }

  return page
}

/** Turn a JSON-RPC error from the peer into an error whose message is actionable. */
export function mcpErrorToWhichtoolError(error: JsonRpcError, ref: string): WhichtoolError {
  switch (error.code) {
    case MCP_ERROR.unsupportedProtocolVersion: {
      const supported =
        isJsonObject(error.data) && Array.isArray(error.data['supported'])
          ? (error.data['supported'] as JsonValue[]).join(', ')
          : '(none advertised)'
      return new WhichtoolError(
        'mcp/unsupported-protocol-version',
        `${ref} does not support MCP ${MCP_PROTOCOL_VERSION}. It advertises: ${supported}.`,
        "whichtool speaks one revision. Capture a tools/list from a client that speaks the server's revision and inspect it with `--transport snapshot`.",
      )
    }
    case MCP_ERROR.headerMismatch:
      return new WhichtoolError(
        'mcp/header-mismatch',
        `${ref} rejected the request headers: ${error.message}`,
        "This is a bug in whichtool's HTTP transport, not in your server. Please report it.",
      )
    case MCP_ERROR.missingRequiredClientCapability: {
      const required =
        isJsonObject(error.data) && Array.isArray(error.data['requiredCapabilities'])
          ? (error.data['requiredCapabilities'] as JsonValue[]).join(', ')
          : '(unspecified)'
      return new WhichtoolError(
        'mcp/missing-client-capability',
        `${ref} requires client capabilities whichtool does not declare: ${required}.`,
        'whichtool declares no client capabilities because it never executes a tool. A server should not need any to list its tools.',
      )
    }
    case MCP_ERROR.methodNotFound:
      return new WhichtoolError(
        'mcp/method-not-found',
        `${ref} does not implement tools/list.`,
        'A server without tools/list has no surface to measure.',
      )
    default:
      return new WhichtoolError(
        'mcp/error-response',
        `${ref} returned JSON-RPC error ${error.code}: ${error.message}`,
      )
  }
}

/** Guard against a server that paginates forever. */
export const MAX_TOOLS_LIST_PAGES = 100

export type SendToolsListRequest = (request: JsonRpcRequest) => Promise<ParsedMessage>

export interface CollectedTools {
  tools: RawTool[]
  diagnostics: Diagnostic[]
  meta: JsonObject
}

/**
 * Drive `tools/list` to completion across pages.
 *
 * Shared by every transport: pagination, cursor-loop detection and cache-directive
 * reporting are protocol concerns, not wire concerns, so no transport reimplements them.
 */
export async function collectTools(
  send: SendToolsListRequest,
  ref: string,
  clientInfo: Implementation | null = WHICHTOOL_CLIENT_INFO,
): Promise<CollectedTools> {
  const tools: RawTool[] = []
  const diagnostics: Diagnostic[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  let serverInfo: Implementation | undefined
  let ttlMs: number | undefined
  let cacheScope: string | undefined

  for (;;) {
    pages += 1
    if (pages > MAX_TOOLS_LIST_PAGES) {
      throw new WhichtoolError(
        'mcp/too-many-pages',
        `${ref} returned more than ${MAX_TOOLS_LIST_PAGES} pages of tools without finishing.`,
      )
    }

    const request = buildToolsListRequest(pages, cursor, clientInfo)
    const message = await send(request)

    if (message.error !== undefined) throw mcpErrorToWhichtoolError(message.error, ref)
    if (message.result === undefined) {
      throw new WhichtoolError(
        'mcp/no-result',
        `${ref} answered tools/list with neither a result nor an error.`,
      )
    }

    const page = readToolsListResult(message.result, ref)
    tools.push(...page.tools)
    if (page.serverInfo !== undefined) serverInfo = page.serverInfo
    if (page.ttlMs !== undefined) ttlMs = page.ttlMs
    if (page.cacheScope !== undefined) cacheScope = page.cacheScope

    if (page.nextCursor === undefined) break
    if (seenCursors.has(page.nextCursor)) {
      throw new WhichtoolError(
        'mcp/cursor-loop',
        `${ref} returned the same pagination cursor twice; the tool list does not terminate.`,
      )
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  const meta: JsonObject = { protocolVersion: MCP_PROTOCOL_VERSION, pages }
  if (serverInfo !== undefined) {
    meta['serverInfo'] = { name: serverInfo.name, version: serverInfo.version }
  }
  if (ttlMs !== undefined) meta['ttlMs'] = ttlMs
  if (cacheScope !== undefined) meta['cacheScope'] = cacheScope

  if (pages > 1) {
    diagnostics.push({
      code: 'mcp/paginated',
      severity: 'info',
      message: `The tool list arrived in ${pages} pages; all of them were read.`,
      detail: { pages },
    })
  }
  if (cacheScope === 'public') {
    diagnostics.push({
      code: 'mcp/public-cache-scope',
      severity: 'info',
      message: `The server marks its tool list \`cacheScope: "public"\`, so shared intermediaries may cache it${ttlMs === undefined ? '' : ` for ${ttlMs} ms`}. Check that nothing in the surface is caller-specific.`,
      detail: { cacheScope, ...(ttlMs === undefined ? {} : { ttlMs }) },
    })
  }

  return { tools, diagnostics, meta }
}

export function redactUrl(raw: string): string {
  return redactSensitiveUrl(raw)
}
