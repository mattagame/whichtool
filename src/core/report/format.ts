import type { Diagnostic, Severity } from '../types.js'

const ANSI = {
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  cyan: '\u001B[36m',
} as const

const RESET = '\u001B[0m'

export type StyleName = keyof typeof ANSI

export interface Styler {
  readonly enabled: boolean
  s(style: StyleName, text: string): string
}

export function createStyler(enabled: boolean): Styler {
  return {
    enabled,
    s(style, text) {
      return enabled ? `${ANSI[style]}${text}${RESET}` : text
    },
  }
}

export interface ColorEnvironment {
  /** `NO_COLOR` from the environment. Its mere presence disables colour, per no-color.org. */
  noColor?: string | undefined
  forceColor?: string | undefined
  isTTY: boolean
}

/** NO_COLOR wins over everything, then FORCE_COLOR, then whether we are on a terminal. */
export function shouldUseColor(env: ColorEnvironment): boolean {
  if (env.noColor !== undefined) return false
  if (env.forceColor !== undefined && env.forceColor !== '' && env.forceColor !== '0') return true
  return env.isTTY
}

export function formatInteger(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatPercent(fraction: number | null, digits = 0): string {
  if (fraction === null) return 'n/a'
  return `${(fraction * 100).toFixed(digits)}%`
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatInteger(count)} ${count === 1 ? singular : pluralForm}`
}

export function truncate(text: string, width: number): string {
  if (text.length <= width) return text
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return `${text.slice(0, width - 1)}~`
}

export type Align = 'left' | 'right'

export interface Column {
  header: string
  align?: Align
  /** Hard cap on rendered width; longer cells are truncated. */
  maxWidth?: number
}

function pad(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - text.length)
  return align === 'right' ? ' '.repeat(gap) + text : text + ' '.repeat(gap)
}

/**
 * Fixed-width table. `indent` is applied to every line so sections can be nested under a
 * heading without the caller doing string surgery.
 */
export function renderTable(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  options: { indent?: string; styler?: Styler } = {},
): string[] {
  const indent = options.indent ?? '  '
  const styler = options.styler
  const capped = rows.map((row) =>
    columns.map((column, index) => {
      const cell = row[index] ?? ''
      return column.maxWidth === undefined ? cell : truncate(cell, column.maxWidth)
    }),
  )

  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...capped.map((row) => (row[index] ?? '').length), 0),
  )

  const renderRow = (cells: readonly string[]): string =>
    columns
      .map((column, index) => pad(cells[index] ?? '', widths[index] ?? 0, column.align ?? 'left'))
      .join('  ')
      .trimEnd()

  const header = renderRow(columns.map((column) => column.header))
  const lines = [indent + (styler ? styler.s('dim', header) : header)]
  for (const row of capped) lines.push(indent + renderRow(row))
  return lines
}

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
export const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'error',
  warning: 'warn ',
  info: 'info ',
}
export const SEVERITY_STYLE: Record<Severity, StyleName> = {
  error: 'red',
  warning: 'yellow',
  info: 'blue',
}

/** Errors first, then warnings, then info, with the code breaking ties so output is stable. */
export function sortDiagnostics<T extends { severity: Severity; code: string }>(
  diagnostics: readonly T[],
): T[] {
  return [...diagnostics].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.code < b.code ? -1 : 1),
  )
}

/** What a diagnostic is about, capped at three names with the remainder counted, not hidden. */
function diagnosticTarget(diagnostic: Diagnostic, fallback: string): string {
  if (diagnostic.tool !== undefined) return diagnostic.tool
  const tools = diagnostic.tools ?? []
  if (tools.length === 0) return fallback
  return tools.length <= 3
    ? tools.join(', ')
    : `${tools.slice(0, 3).join(', ')} +${tools.length - 3} more`
}

/**
 * One diagnostic, wrapped: severity, code, and what it is about.
 *
 * `fallbackTarget` names what a diagnostic with no tool attached refers to. Leaving it out
 * drops the target column entirely, which is what the reports whose findings are always
 * whole-report rather than per-tool do.
 *
 * Continuation lines are indented past the severity label so the message sits under the
 * code rather than running back to the left margin.
 */
export function renderDiagnostic(
  styler: Styler,
  diagnostic: Diagnostic,
  width: number,
  options: { firstIndent?: string; restIndent?: string; fallbackTarget?: string } = {},
): string[] {
  const firstIndent = options.firstIndent ?? '  '
  const restIndent = options.restIndent ?? ' '.repeat(firstIndent.length)
  const cells = [
    `${firstIndent}${styler.s(SEVERITY_STYLE[diagnostic.severity], SEVERITY_LABEL[diagnostic.severity])}`,
    styler.s('cyan', diagnostic.code),
  ]
  if (options.fallbackTarget !== undefined) {
    cells.push(styler.s('dim', diagnosticTarget(diagnostic, options.fallbackTarget)))
  }
  return [cells.join('  '), ...wrap(diagnostic.message, width, `${restIndent}       `)]
}

/** Wrap text to `width`, prefixing every produced line with `indent`. */
export function wrap(text: string, width: number, indent = ''): string[] {
  const limit = Math.max(20, width - indent.length)
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let current = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (current.length === 0) {
        current = word
      } else if (current.length + 1 + word.length <= limit) {
        current += ` ${word}`
      } else {
        lines.push(indent + current)
        current = word
      }
    }
    lines.push(indent + current)
  }
  return lines
}
