import { NotImplementedError, WhichtoolError } from '../errors.js'
import { createHttpTransport } from './http.js'
import { createSnapshotTransport } from './snapshot.js'
import { createStdioTransport } from './stdio.js'
import type { TargetSpec, Transport, TransportDeps } from './types.js'

export { extractTools, createSnapshotTransport, snapshotTransportFromData } from './snapshot.js'
export { createHttpTransport, readSseResponse } from './http.js'
export { createStdioTransport, splitCommandLine, stdioTransportFromProcess } from './stdio.js'
export {
  buildToolsListRequest,
  collectTools,
  MCP_ERROR,
  MCP_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  readToolsListResult,
  redactUrl,
  toolsListHttpHeaders,
} from './mcp.js'
export type {
  ListToolsResult,
  McpProcess,
  SpawnSpec,
  TargetSpec,
  Transport,
  TransportDeps,
  TransportKind,
} from './types.js'

export async function createTransport(spec: TargetSpec, deps: TransportDeps): Promise<Transport> {
  switch (spec.transport) {
    case 'snapshot':
      return createSnapshotTransport(spec.path, deps)

    case 'http': {
      const options: Parameters<typeof createHttpTransport>[0] = { url: spec.url }
      if (spec.headers !== undefined) options.headers = spec.headers
      if (deps.fetch !== undefined) options.fetch = deps.fetch
      return createHttpTransport(options)
    }

    case 'stdio': {
      const options: Parameters<typeof createStdioTransport>[0] = { command: spec.command }
      if (spec.args !== undefined) options.args = spec.args
      if (spec.cwd !== undefined) options.cwd = spec.cwd
      if (spec.env !== undefined) options.env = spec.env
      return createStdioTransport(options, deps)
    }

    case 'legacy-sse':
      throw new NotImplementedError(
        'The deprecated 2024-11-05 HTTP+SSE transport is not implemented.',
        'It has been Deprecated since MCP 2025-03-26 and is in the removal registry ' +
          '(/specification/2026-07-28/deprecated), so whichtool does not carry an implementation. ' +
          "Point `--transport http` at the server's Streamable HTTP endpoint, or capture a " +
          'tools/list from a client that speaks the old transport and use `--transport snapshot`.',
      )

    default: {
      const unknown = spec as { transport?: unknown }
      throw new WhichtoolError(
        'target/unknown-transport',
        `Unknown transport \`${String(unknown.transport)}\`.`,
        'Valid transports: snapshot, http, stdio, legacy-sse.',
      )
    }
  }
}
