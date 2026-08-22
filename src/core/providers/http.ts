import { isJsonObject } from '../json.js'
import type { JsonObject, JsonValue } from '../types.js'
import {
  credentialHeaderValues,
  redactKnownHttpSecrets,
  redactSensitiveUrl,
} from '../url-redaction.js'
import { ProviderError } from './types.js'

export const DEFAULT_TIMEOUT_MS = 300_000
// A retry can turn one trial into another billable provider request. Cost-sensitive callers
// get one attempt by default; programmatic callers may still opt in explicitly.
export const DEFAULT_RETRIES = 0
const RETRY_BASE_MS = 500
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

// AbortSignal.aborted is typed readonly even though it changes asynchronously. Reading it
// through a function prevents TypeScript from treating the pre-await value as permanent.
function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export interface JsonPosterOptions {
  endpoint: string
  headers: Record<string, string>
  fetch?: typeof fetch
  timeoutMs?: number
  retries?: number
}

/** Strip credential-bearing URL material before it reaches a message, a log or a report. */
export function stripCredentials(url: string): string {
  return redactSensitiveUrl(url)
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
    return
  }
  if (signal.aborted) return

  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

async function boundedResponseText(response: Response, endpoint: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ProviderError(
      `${endpoint} declared a response larger than ${MAX_RESPONSE_BYTES} bytes.`,
      { retryable: false },
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
          throw new ProviderError(`${endpoint} returned more than ${MAX_RESPONSE_BYTES} bytes.`, {
            retryable: false,
          })
        }
        text += decoder.decode(value, { stream: true })
      }
      if (done) return text + decoder.decode()
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/**
 * POST JSON and return the parsed object. Transient failures are retried only when the caller
 * explicitly opts in with `retries`.
 *
 * Shared by every HTTP provider so that timeout, backoff and credential stripping behave
 * identically whichever endpoint a run points at — a provider that retried differently
 * would make two runs incomparable for a reason that has nothing to do with the surface.
 */
export function createJsonPoster(
  options: JsonPosterOptions,
): (body: JsonObject, signal: AbortSignal | undefined) => Promise<JsonObject> {
  const doFetch = options.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new ProviderError('no global `fetch` is available', { retryable: false })
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES)
  const safeEndpoint = stripCredentials(options.endpoint)
  const credentials = credentialHeaderValues(options.headers)

  return async (body: JsonObject, signal: AbortSignal | undefined): Promise<JsonObject> => {
    let lastError: ProviderError | null = null
    const cancelled = (): ProviderError =>
      new ProviderError(`${safeEndpoint}: request cancelled`, { retryable: false })

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (isAbortRequested(signal)) throw cancelled()
      if (attempt > 0) {
        // Plain exponential backoff, no jitter: two runs with the same inputs should take
        // the same shape, and a random delay buys little against a single endpoint.
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal)
        if (isAbortRequested(signal)) throw cancelled()
      }

      let response: Response
      try {
        response = await doFetch(options.endpoint, {
          method: 'POST',
          headers: options.headers,
          body: JSON.stringify(body),
          signal:
            signal === undefined
              ? AbortSignal.timeout(timeoutMs)
              : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        })
      } catch (cause) {
        const callerAborted = isAbortRequested(signal)
        const rawMessage = callerAborted
          ? 'request cancelled'
          : cause instanceof Error
            ? cause.message
            : String(cause)
        const message = redactKnownHttpSecrets(
          rawMessage,
          options.endpoint,
          safeEndpoint,
          credentials,
        )
        const aborted = callerAborted || (cause instanceof Error && cause.name === 'AbortError')
        lastError = new ProviderError(`${safeEndpoint}: ${message}`, { retryable: !aborted })
        if (aborted) throw lastError
        continue
      }

      if (response.ok) {
        const text = await boundedResponseText(response, safeEndpoint)
        try {
          const parsed = JSON.parse(text) as JsonValue
          if (!isJsonObject(parsed)) throw new Error('response is not a JSON object')
          return parsed
        } catch (cause) {
          throw new ProviderError(
            `${safeEndpoint} returned an unreadable body: ${cause instanceof Error ? cause.message : String(cause)}`,
            { retryable: false },
          )
        }
      }

      const detail = redactKnownHttpSecrets(
        await boundedResponseText(response, safeEndpoint).catch(() => ''),
        options.endpoint,
        safeEndpoint,
        credentials,
      ).slice(0, 300)
      const retryable = response.status === 429 || response.status >= 500
      lastError = new ProviderError(`${safeEndpoint} answered HTTP ${response.status}: ${detail}`, {
        retryable,
        status: response.status,
        ...(response.status === 401 || response.status === 403
          ? {
              hint: "Set the provider's API key in its own environment variable; whichtool never reads it from a config file.",
            }
          : {}),
      })
      if (!retryable) throw lastError
    }

    throw lastError ?? new ProviderError('request failed', { retryable: false })
  }
}
