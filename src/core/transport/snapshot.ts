import { WhichtoolError } from '../errors.js'
import { isJsonObject } from '../json.js'
import type { Diagnostic, RawTool } from '../types.js'
import type { ListToolsResult, Transport, TransportDeps } from './types.js'

/**
 * Pull the tool array out of whatever shape the snapshot was saved in.
 *
 * People capture `tools/list` in three ways and all three are worth accepting: the bare
 * result object, the full JSON-RPC envelope, or just the array.
 */
export function extractTools(payload: unknown, ref: string): { tools: RawTool[]; shape: string } {
  if (Array.isArray(payload)) return { tools: payload as RawTool[], shape: 'array' }

  if (isJsonObject(payload)) {
    const direct = payload['tools']
    if (Array.isArray(direct)) return { tools: direct as RawTool[], shape: 'result' }

    const result = payload['result']
    if (isJsonObject(result) && Array.isArray(result['tools'])) {
      return { tools: result['tools'] as RawTool[], shape: 'jsonrpc' }
    }

    const error = payload['error']
    if (isJsonObject(error)) {
      throw new WhichtoolError(
        'snapshot/jsonrpc-error',
        `Snapshot ${ref} contains a JSON-RPC error response, not a tool list: ${JSON.stringify(error)}`,
      )
    }
  }

  throw new WhichtoolError(
    'snapshot/unrecognised-shape',
    `Snapshot ${ref} does not contain a tool list.`,
    'Expected one of: `{"tools": [...]}`, `{"result": {"tools": [...]}}`, or a bare `[...]` array.',
  )
}

/** Build a snapshot transport from already-parsed JSON. Does no I/O. */
export function snapshotTransportFromData(payload: unknown, ref: string): Transport {
  const { tools, shape } = extractTools(payload, ref)
  const diagnostics: Diagnostic[] = []
  if (shape === 'array') {
    diagnostics.push({
      code: 'snapshot/bare-array',
      severity: 'info',
      message: `Snapshot ${ref} is a bare array; any transport metadata it may have carried is not available.`,
    })
  }
  return {
    kind: 'snapshot',
    ref,
    async listTools(): Promise<ListToolsResult> {
      return { tools, diagnostics }
    },
  }
}

/** Build a snapshot transport by reading a file through the injected runtime. */
export async function createSnapshotTransport(
  path: string,
  deps: TransportDeps,
  ref = path,
): Promise<Transport> {
  let text: string
  try {
    text = await deps.readTextFile(path)
  } catch (cause) {
    throw new WhichtoolError(
      'snapshot/unreadable',
      `Cannot read snapshot ${ref}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'Capture one with your MCP client, or point `--transport http` at the live server.',
    )
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (cause) {
    throw new WhichtoolError(
      'snapshot/invalid-json',
      `Snapshot ${ref} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  return snapshotTransportFromData(payload, ref)
}
