import { WhichtoolError } from '../errors.js'
import type { JsonValue } from '../types.js'

interface Line {
  indent: number
  content: string

  number: number
}

/**
 * Tokenizing strips comments and drops blank lines, which is right for structure and
 * wrong inside a `|` or `>` block, where a `#` and a blank line are both content. The
 * block-scalar reader works from these untouched source lines instead.
 */
type Source = readonly string[]

function fail(message: string, line?: Line): never {
  throw new WhichtoolError(
    'yaml/unsupported',
    line === undefined ? message : `Line ${line.number}: ${message}`,
    'whichtool reads a documented subset of YAML. Anything outside it is refused rather than guessed at; see docs/task-sets.md. A `.json` task set is always accepted.',
  )
}

/** Strip a trailing `#` comment, ignoring `#` inside quotes. */
function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    // A `#` only starts a comment at the start of the line or after whitespace.
    if (char === '#' && (index === 0 || /\s/.test(raw[index - 1] as string))) {
      return raw.slice(0, index)
    }
  }
  return raw
}

function tokenize(text: string, source: string[]): Line[] {
  const lines: Line[] = []
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  source.push(...raw)

  for (const [index, original] of raw.entries()) {
    const number = index + 1
    if (original.includes('\t') && /^\s*\t/.test(original)) {
      fail('YAML forbids tab characters in indentation.', { indent: 0, content: original, number })
    }
    const withoutComment = stripComment(original)
    if (withoutComment.trim().length === 0) continue

    const indent = withoutComment.length - withoutComment.trimStart().length
    const content = withoutComment.trimEnd().slice(indent)

    if (content === '---') {
      if (lines.length > 0)
        fail('Multiple YAML documents are not supported.', { indent, content, number })
      continue
    }
    if (content === '...') continue

    lines.push({ indent, content, number })
  }
  return lines
}

const RESERVED_START = /^[&*!]/

function parseScalar(text: string, line: Line): JsonValue {
  const value = text.trim()

  if (value === '' || value === 'null' || value === '~' || value === 'Null' || value === 'NULL') {
    return null
  }
  if (RESERVED_START.test(value)) {
    fail(
      `\`${value[0]}\` starts a YAML anchor, alias or tag, which whichtool does not support.`,
      line,
    )
  }
  if (value.startsWith('{')) fail('Flow mappings (`{ ... }`) are not supported.', line)

  if (value.startsWith('[')) {
    if (!value.endsWith(']')) fail('Unterminated flow sequence.', line)
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return splitFlow(inner, line).map((item) => parseScalar(item, line))
  }

  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) fail('Unterminated double-quoted string.', line)
    return unescapeDouble(value.slice(1, -1), line)
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) fail('Unterminated single-quoted string.', line)
    return value.slice(1, -1).replace(/''/g, "'")
  }

  if (value === 'true' || value === 'True' || value === 'TRUE') return true
  if (value === 'false' || value === 'False' || value === 'FALSE') return false
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return Number(value)

  return value
}

function splitFlow(body: string, line: Line): string[] {
  const items: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string
    if (quote !== null) {
      current += char
      if (char === '\\' && quote === '"') {
        current += body[index + 1] ?? ''
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') fail('Nested flow collections are not supported.', line)
    if (char === ',') {
      items.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (quote !== null) fail('Unterminated quote in a flow sequence.', line)
  if (current.trim() !== '') items.push(current)
  return items
}

function unescapeDouble(body: string, line: Line): string {
  let out = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string
    if (char !== '\\') {
      out += char
      continue
    }
    const next = body[index + 1]
    index += 1
    switch (next) {
      case 'n':
        out += '\n'
        break
      case 't':
        out += '\t'
        break
      case 'r':
        out += '\r'
        break
      case '"':
        out += '"'
        break
      case '\\':
        out += '\\'
        break
      case '/':
        out += '/'
        break
      case '0':
        out += '\0'
        break
      case 'u': {
        const hex = body.slice(index + 1, index + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Malformed \\u escape.', line)
        out += String.fromCharCode(Number.parseInt(hex, 16))
        index += 4
        break
      }
      default:
        fail(`Unsupported escape \\${String(next)}.`, line)
    }
  }
  return out
}

/** `key:` at the start of a line, with the key unquoted or quoted. */
const MAPPING_KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#\s][^:]*?)\s*:(\s|$)/

class Cursor {
  private index = 0
  constructor(
    private readonly lines: Line[],
    private readonly source: Source = [],
  ) {}

  /** The untouched source lines for an inclusive, 1-based line range. */
  sourceLines(from: number, to: number): string[] {
    return this.source.slice(from - 1, to)
  }
  sourceCount(): number {
    return this.source.length
  }

  peek(): Line | undefined {
    return this.lines[this.index]
  }
  next(): Line {
    const line = this.lines[this.index]
    if (line === undefined) fail('Unexpected end of input.')
    this.index += 1
    return line
  }
  /** Replace the current line with one that starts further right; used for `- key: value`. */
  substitute(line: Line): void {
    this.lines[this.index] = line
  }
  atEnd(): boolean {
    return this.index >= this.lines.length
  }
}

function parseBlockScalar(
  cursor: Cursor,
  header: string,
  parentIndent: number,
  line: Line,
): string {
  const style = header[0] as '|' | '>'
  const chomp = header.slice(1).trim()
  if (chomp !== '' && chomp !== '-') {
    fail(`Only the \`-\` chomping indicator is supported, not \`${chomp}\`.`, line)
  }

  // Consume the block's tokens to advance the cursor, but keep only the line numbers:
  // the text is read back from the source, where the comments and blank lines the
  // tokenizer removed are still intact.
  let blockIndent: number | null = null
  let first: number | null = null
  let last: number | null = null
  for (;;) {
    const candidate = cursor.peek()
    if (candidate === undefined || candidate.indent <= parentIndent) break
    if (blockIndent === null) {
      blockIndent = candidate.indent
      first = candidate.number
    }
    last = candidate.number
    cursor.next()
  }

  if (blockIndent === null || first === null || last === null) {
    return chomp === '-' ? '' : '\n'
  }

  // A line the tokenizer dropped entirely — blank, or nothing but a `#` comment — leaves
  // no token to consume, so the block's last content token may not be its last line.
  // Anything still indented past the parent belongs to the block; walk forward to it.
  const tail = cursor.sourceLines(first, cursor.sourceCount())
  let take = last - first + 1
  for (let index = take; index < tail.length; index += 1) {
    const raw = tail[index] as string
    if (raw.trim() === '') continue
    if (indentOf(raw) <= parentIndent) break
    take = index + 1
  }

  // Trailing blank lines belong to the block but are removed by both supported chomping
  // indicators, so stopping at the last content line is already the right answer.
  const collected = tail.slice(0, take).map((raw) => {
    const body = raw.replace(/\s+$/, '')
    return body.trim() === '' ? '' : body.slice(Math.min(blockIndent, indentOf(body)))
  })

  if (style === '|') {
    const text = collected.join('\n')
    return chomp === '-' ? text : `${text}\n`
  }

  // Folded: a line break becomes a space, a blank line becomes a real newline. A
  // more-indented line is literal in YAML, and folding it would silently rewrite the
  // prompt, so it is refused instead.
  if (collected.some((body) => body !== '' && indentOf(body) > 0)) {
    fail('A folded (`>`) block with more-indented lines is not supported; use `|`.', line)
  }
  let text = ''
  let index = 0
  while (index < collected.length) {
    if ((collected[index] as string) === '') {
      let blanks = 0
      while (index < collected.length && (collected[index] as string) === '') {
        blanks += 1
        index += 1
      }
      text += '\n'.repeat(blanks)
      continue
    }
    if (text !== '' && !text.endsWith('\n')) text += ' '
    text += collected[index] as string
    index += 1
  }
  return chomp === '-' ? text : `${text}\n`
}

function indentOf(raw: string): number {
  return raw.length - raw.trimStart().length
}

function parseNode(cursor: Cursor, indent: number): JsonValue {
  const first = cursor.peek()
  if (first === undefined) return null

  if (first.content === '-' || first.content.startsWith('- ')) {
    return parseSequence(cursor, indent)
  }
  return parseMapping(cursor, indent)
}

function parseSequence(cursor: Cursor, indent: number): JsonValue[] {
  const items: JsonValue[] = []

  for (;;) {
    const line = cursor.peek()
    if (line === undefined || line.indent !== indent) break
    if (line.content !== '-' && !line.content.startsWith('- ')) break

    const afterDash = line.content.slice(1)
    const gap = afterDash.length - afterDash.trimStart().length
    const rest = afterDash.trimStart()
    // The content column, so `-   id: x` puts the mapping keys under `id`, not under `-`.
    const restIndent = indent + 1 + gap

    if (rest === '') {
      cursor.next()
      const child = cursor.peek()
      items.push(
        child !== undefined && child.indent > indent ? parseNode(cursor, child.indent) : null,
      )
      continue
    }

    if (MAPPING_KEY.test(rest)) {
      // `- id: x` opens a mapping whose keys sit at the column of `id`. The line is
      // rewritten in place and *not* consumed first: advancing before substituting would
      // overwrite the next line, silently dropping the second key of every item.
      cursor.substitute({ indent: restIndent, content: rest, number: line.number })
      items.push(parseMapping(cursor, restIndent))
      continue
    }

    cursor.next()
    items.push(parseScalar(rest, line))
  }

  return items
}

function parseMapping(cursor: Cursor, indent: number): Record<string, JsonValue> {
  const map: Record<string, JsonValue> = {}

  for (;;) {
    const line = cursor.peek()
    if (line === undefined || line.indent !== indent) break
    if (line.content === '-' || line.content.startsWith('- ')) break

    const match = MAPPING_KEY.exec(line.content)
    if (match === null) {
      fail(`Expected \`key: value\`, got \`${line.content}\`.`, line)
    }
    cursor.next()

    const rawKey = match[1] as string
    if (rawKey === '<<') fail('Merge keys (`<<`) are not supported.', line)
    const key = String(parseScalar(rawKey, line))
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      fail(`Duplicate key \`${key}\`.`, line)
    }

    const rest = line.content.slice(match[0].length).trim()

    if (rest.startsWith('|') || rest.startsWith('>')) {
      map[key] = parseBlockScalar(cursor, rest, indent, line)
      continue
    }
    if (rest !== '') {
      map[key] = parseScalar(rest, line)
      continue
    }

    const child = cursor.peek()
    map[key] = child !== undefined && child.indent > indent ? parseNode(cursor, child.indent) : null
  }

  return map
}

export function parseYamlSubset(text: string): JsonValue {
  const source: string[] = []
  const lines = tokenize(text, source)
  if (lines.length === 0) return null

  const cursor = new Cursor(lines, source)
  const baseIndent = (lines[0] as Line).indent
  const value = parseNode(cursor, baseIndent)

  if (!cursor.atEnd()) {
    const line = cursor.peek() as Line
    fail(`Unexpected indentation; expected the document to end here.`, line)
  }
  return value
}
