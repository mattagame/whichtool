const TOKEN_LIKE_PATH_SEGMENT = /^[A-Za-z0-9._~-]{16,}$/
const CREDENTIAL_PREFIX = /^(?:api[-_]?key|bearer|secret|sk|token)[-_]/i
const CREDENTIAL_QUERY_NAME =
  /authorization|api[-_]?key|token|secret|signature|password|code|credential/i
const CREDENTIAL_HEADER_NAME = /authorization|api[-_]?key|token|secret|cookie/i

function decoded(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function looksLikeCredential(value: string): boolean {
  const candidate = decoded(value)
  if (candidate.length >= 12 && CREDENTIAL_PREFIX.test(candidate)) return true
  return (
    TOKEN_LIKE_PATH_SEGMENT.test(candidate) && /[A-Za-z]/.test(candidate) && /[0-9]/.test(candidate)
  )
}

function redactedPathname(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (looksLikeCredential(segment) ? '***' : segment))
    .join('/')
}

export function credentialHeaderValues(headers: Readonly<Record<string, string>>): string[] {
  const fragments = new Set<string>()
  for (const [name, rawValue] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADER_NAME.test(name) || rawValue === '') continue
    fragments.add(rawValue)

    // Providers and proxies often echo only the token portion of an Authorization value.
    const separator = rawValue.indexOf(' ')
    if (separator >= 0) {
      const credential = rawValue.slice(separator + 1).trim()
      if (credential !== '') fragments.add(credential)
    }
    if (/cookie/i.test(name)) {
      for (const part of rawValue.split(';')) {
        const equals = part.indexOf('=')
        if (equals >= 0) {
          const cookieValue = part.slice(equals + 1).trim()
          if (cookieValue !== '') fragments.add(cookieValue)
        }
      }
    }
  }
  return [...fragments].sort((left, right) => right.length - left.length)
}

export function redactKnownHttpSecrets(
  message: string,
  rawUrl: string,
  displayUrl: string,
  credentials: readonly string[],
): string {
  let sanitized = rawUrl === displayUrl ? message : message.split(rawUrl).join(displayUrl)
  for (const credential of credentials) sanitized = sanitized.split(credential).join('***')
  return sanitized
}

/**
 * Produce a URL suitable for reports and error messages. The original URL remains available
 * to the caller for the actual request and for one-way fingerprints, but never leaves through
 * this display value.
 */
export function redactSensitiveUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const hadUserinfo = url.username !== '' || url.password !== ''
    url.username = ''
    url.password = ''

    url.pathname = redactedPathname(url.pathname)

    if (url.search !== '') {
      const safeParams = new URLSearchParams()
      for (const [name] of url.searchParams) {
        safeParams.append(looksLikeCredential(name) ? 'redacted' : name, '***')
      }
      url.search = safeParams.toString()
    }
    if (url.hash !== '') url.hash = '#***'

    const serialized = url.toString()
    return hadUserinfo
      ? serialized.replace(`${url.protocol}//`, `${url.protocol}//***@`)
      : serialized
  } catch {
    // Echoing an unparseable value is not a safe fallback: it may be malformed precisely
    // because it embeds a credential in a non-standard shape.
    return '(invalid URL)'
  }
}

/**
 * Keep endpoint behaviour comparable without placing URL credentials, or deterministic hashes
 * of weak credentials, in a report. Unlike the display form, non-sensitive query values remain
 * because options such as `api-version` can change provider semantics.
 */
export function urlForBehaviorFingerprint(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.pathname = redactedPathname(url.pathname)

    if (url.search !== '') {
      const safeParams = new URLSearchParams()
      for (const [rawName, value] of url.searchParams) {
        const secretName = looksLikeCredential(rawName)
        const name = secretName ? 'redacted' : rawName
        safeParams.append(name, secretName || CREDENTIAL_QUERY_NAME.test(rawName) ? '***' : value)
      }
      url.search = safeParams.toString()
    }
    url.hash = ''
    return url.toString()
  } catch {
    return '(invalid URL)'
  }
}
