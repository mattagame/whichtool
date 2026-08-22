const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g

function escapedCodePoint(character: string): string {
  switch (character) {
    case '\n':
      return '\\n'
    case '\r':
      return '\\r'
    case '\t':
      return '\\t'
  }
  const codePoint = character.codePointAt(0) as number
  return codePoint <= 0xff
    ? `\\x${codePoint.toString(16).padStart(2, '0')}`
    : `\\u${codePoint.toString(16).padStart(4, '0')}`
}

/** Make untrusted report text printable without allowing ANSI, terminal, or bidi controls. */
export function sanitizeText(value: string): string {
  return value.replace(UNSAFE_TEXT, escapedCodePoint)
}

/** Reports are plain data; sanitising a copy at a text-renderer boundary covers every field. */
export function sanitizeTextValue<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as T
  if (Array.isArray(value)) return value.map((child) => sanitizeTextValue(child)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[sanitizeText(key)] = sanitizeTextValue(child)
    }
    return out as T
  }
  return value
}
