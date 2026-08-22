import { WhichtoolError } from '../core/errors.js'
import { createTransport } from '../core/transport/index.js'
import { createSnapshotTransport } from '../core/transport/snapshot.js'
import type {
  TargetSpec,
  Transport,
  TransportDeps,
  TransportKind,
} from '../core/transport/types.js'
import type { WhichtoolConfig } from '../config.js'
import type { Runtime } from '../runtime/types.js'
import { toDisplayPath } from './paths.js'

const TRANSPORTS: readonly TransportKind[] = ['snapshot', 'http', 'stdio', 'legacy-sse']

export function isTransportKind(value: string): value is TransportKind {
  return (TRANSPORTS as readonly string[]).includes(value)
}

export interface ResolveTargetOptions {
  transport?: string | undefined
  config?: WhichtoolConfig | undefined
  /**
   * Whether an HTTP target may receive the authorization token from the process environment.
   * Agent-facing callers set this to false for targets supplied at tool-call time.
   */
  allowEnvAuthorization?: boolean | undefined
}

/** Environment variable carrying the `Authorization` header for an HTTP target. */
export const AUTHORIZATION_ENV = 'WHICHTOOL_HTTP_AUTHORIZATION'
/** Exact origin allowed to receive {@link AUTHORIZATION_ENV}, for example `https://mcp.example`. */
export const AUTHORIZATION_ORIGIN_ENV = 'WHICHTOOL_HTTP_AUTHORIZATION_ORIGIN'

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(normalized)
  )
}

function targetUrl(spec: Extract<TargetSpec, { transport: 'http' | 'legacy-sse' }>): URL {
  try {
    return new URL(spec.url)
  } catch {
    throw new WhichtoolError('http/invalid-url', 'The HTTP target is not a valid URL.')
  }
}

function assertSafeAuthorizationTarget(url: URL): void {
  if (url.protocol === 'https:' || isLoopback(url.hostname)) return
  throw new WhichtoolError(
    'http/insecure-authorization-target',
    `Refusing to send an Authorization header over ${url.protocol}//${url.host}. Use HTTPS for a remote target.`,
    'Use HTTPS for a remote target. Plain HTTP credentials are allowed only on loopback.',
  )
}

export function applyEnvHeaders(
  spec: TargetSpec,
  readEnv: (key: string) => string | undefined,
  options: { allowAuthorization?: boolean } = {},
): TargetSpec {
  if (spec.transport !== 'http' && spec.transport !== 'legacy-sse') return spec
  const url = targetUrl(spec)
  const existing = spec.headers ?? {}
  if (Object.keys(existing).some((key) => key.toLowerCase() === 'authorization')) {
    assertSafeAuthorizationTarget(url)
    return spec
  }

  if (options.allowAuthorization === false) return spec
  const authorization = readEnv(AUTHORIZATION_ENV)
  if (authorization === undefined || authorization === '') return spec

  const rawOrigin = readEnv(AUTHORIZATION_ORIGIN_ENV)
  if (rawOrigin === undefined || rawOrigin.trim() === '') {
    throw new WhichtoolError(
      'http/authorization-origin-required',
      `\`${AUTHORIZATION_ENV}\` is set, but \`${AUTHORIZATION_ORIGIN_ENV}\` is not.`,
      `Set ${AUTHORIZATION_ORIGIN_ENV}=${url.origin} so the credential cannot follow an accidental target change.`,
    )
  }
  let allowedOrigin: string
  try {
    allowedOrigin = new URL(rawOrigin).origin
  } catch {
    throw new WhichtoolError(
      'http/invalid-authorization-origin',
      `\`${AUTHORIZATION_ORIGIN_ENV}\` is not a valid URL origin.`,
    )
  }
  if (allowedOrigin !== url.origin) {
    throw new WhichtoolError(
      'http/authorization-origin-mismatch',
      `Refusing to send the HTTP Authorization header to ${url.origin}.`,
      `\`${AUTHORIZATION_ORIGIN_ENV}\` allows only ${allowedOrigin}.`,
    )
  }
  assertSafeAuthorizationTarget(url)
  return { ...spec, headers: { ...existing, Authorization: authorization } }
}

export function resolveTarget(
  input: string | undefined,
  options: ResolveTargetOptions = {},
): TargetSpec {
  const { transport, config } = options

  if (transport !== undefined) {
    if (!isTransportKind(transport)) {
      throw new WhichtoolError(
        'target/unknown-transport',
        `Unknown transport \`${transport}\`.`,
        `Valid transports: ${TRANSPORTS.join(', ')}.`,
      )
    }
    if (input === undefined) {
      const configured = config?.target
      if (configured !== undefined && configured.transport === transport) return configured
      throw new WhichtoolError(
        'target/missing',
        `\`--transport ${transport}\` needs a target argument.`,
      )
    }
    switch (transport) {
      case 'snapshot':
        return { transport: 'snapshot', path: input }
      case 'http':
        return { transport: 'http', url: input }
      case 'legacy-sse':
        return { transport: 'legacy-sse', url: input }
      case 'stdio':
        return { transport: 'stdio', command: input }
    }
  }

  if (input === undefined) {
    const configured = config?.target
    if (configured !== undefined) return configured
    throw new WhichtoolError(
      'target/missing',
      'No target given and no `target` in the config.',
      'Pass a captured tool list (`whichtool inspect ./tools.json`) or add `target` to whichtool.config.ts.',
    )
  }

  if (/^https?:\/\//i.test(input)) return { transport: 'http', url: input }
  if (/\.json$/i.test(input)) return { transport: 'snapshot', path: input }

  throw new WhichtoolError(
    'target/ambiguous',
    'Cannot tell what kind of target was supplied.',
    'A URL means http, a path ending in .json means snapshot. For anything else say so: `--transport stdio "bun run ./src/server.ts"`.',
  )
}

/**
 * Resolve a target and open it.
 *
 * Every command that reaches a server resolves the target, folds in HTTP authorization,
 * separates a snapshot's read path from its safe display name, and injects runtime I/O.
 */
export async function openTarget(
  runtime: Runtime,
  input: string | undefined,
  options: ResolveTargetOptions = {},
): Promise<Transport> {
  const spec = applyEnvHeaders(resolveTarget(input, options), (key) => runtime.env(key), {
    allowAuthorization: options.allowEnvAuthorization !== false,
  })
  const deps: TransportDeps = {
    readTextFile: (path) => runtime.readTextFile(runtime.resolve(path)),
    fetch: globalThis.fetch,
    spawn: (processSpec) => runtime.spawnProcess(processSpec),
  }
  return spec.transport === 'snapshot'
    ? createSnapshotTransport(spec.path, deps, toDisplayPath(runtime, spec.path))
    : createTransport(spec, deps)
}
