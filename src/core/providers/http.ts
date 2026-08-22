import { isJsonObject } from '../json.js'
import type { JsonObject, JsonValue } from '../types.js'
import {
  credentialHeaderValues,
  redactKnownHttpSecrets,
  redactSensitiveUrl,
} from '../url-redaction.js'
import { ProviderError } from './types.js'

export const DEFAULT_TIMEOUT_MS = 300_000
export const DEFAULT_RETRIES = 3
const RETRY_BASE_MS = 500
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
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
 * POST JSON and return the parsed object, retrying what is worth retrying.
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

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        // Plain exponential backoff, no jitter: two runs with the same inputs should take
        // the same shape, and a random delay buys little against a single endpoint.
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
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
        const rawMessage = cause instanceof Error ? cause.message : String(cause)
        const message = redactKnownHttpSecrets(
          rawMessage,
          options.endpoint,
          safeEndpoint,
          credentials,
        )
        const aborted = cause instanceof Error && cause.name === 'AbortError'
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
