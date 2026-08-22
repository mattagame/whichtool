import { topFindings, type InspectReport, type InspectToolSummary } from '../inspect.js'
import { NOTABLE_OVERLAP } from '../static/overlap.js'
import { shortHash } from '../surface/hash.js'
import {
  createStyler,
  formatInteger,
  formatPercent,
  plural,
  renderDiagnostic,
  renderTable,
  wrap,
  type Column,
  type Styler,
} from './format.js'
import { sanitizeTextValue } from './sanitize.js'

export interface TerminalOptions {
  color: boolean
  width?: number

  maxTools?: number

  maxOverlapRows?: number
}

function heading(styler: Styler, text: string): string {
  return styler.s('bold', text)
}

function tokenRows(tools: readonly InspectToolSummary[]): string[][] {
  return tools.map((tool) => [
    tool.name,
    `~${formatInteger(tool.tokens.total)}`,
    formatPercent(tool.tokenShare),
    `~${formatInteger(tool.tokens.description)}`,
    `~${formatInteger(tool.tokens.schema)}`,
    tool.hasDescription ? '' : 'no description',
  ])
}

const TOKEN_COLUMNS: Column[] = [
  { header: 'tool', maxWidth: 40 },
  { header: 'tokens', align: 'right' },
  { header: 'share', align: 'right' },
  { header: 'desc', align: 'right' },
  { header: 'schema', align: 'right' },
  { header: '' },
]

/**
 * The terminal reporter.
 *
 * Structure follows SPEC §5.8: the three worst things first, then the evidence. Colour is
 * decided by the caller (NO_COLOR and TTY detection live in the CLI), and every number
 * that is an estimate carries a `~` so it can never be mistaken for a measurement.
 */
export function renderInspectTerminal(report: InspectReport, options: TerminalOptions): string {
  report = sanitizeTextValue(report)
  const styler = createStyler(options.color)
  const width = options.width ?? 88
  const maxTools = options.maxTools ?? 15
  const maxOverlapRows = options.maxOverlapRows ?? 8
  const lines: string[] = []

  const estimateSuffix = report.tokens.tokenizer.exact
    ? `(${report.tokens.tokenizer.id})`
    : `(estimate, ${report.tokens.tokenizer.id})`

  lines.push(heading(styler, 'whichtool inspect'))
  lines.push(`  ${styler.s('dim', 'target ')}  ${report.target.transport}  ${report.target.ref}`)
  lines.push(
    `  ${styler.s('dim', 'surface')}  ${shortHash(report.surface.hash)}  ` +
      `${plural(report.surface.toolCount, 'tool')}  ` +
      `~${formatInteger(report.tokens.total)} tokens ${estimateSuffix}`,
  )
  if (report.headerParams.rejectedTools.length > 0) {
    // This changes the effective size of the surface, so it belongs in the header rather
    // than only in the findings list further down.
    lines.push(
      `  ${styler.s('dim', '       ')}  ` +
        styler.s(
          'red',
          `${plural(report.headerParams.rejectedTools.length, 'tool')} excluded by conforming clients: ${report.headerParams.rejectedTools.join(', ')}`,
        ),
    )
  }

  // Worst first
  const counts = { error: 0, warning: 0, info: 0 }
  for (const diagnostic of report.diagnostics) counts[diagnostic.severity] += 1
  const loud = counts.error + counts.warning
  const worst = topFindings(report, 3)

  lines.push('')
  lines.push(heading(styler, 'Worst first'))
  if (worst.length === 0) {
    lines.push(
      `  ${styler.s('green', 'No errors or warnings.')}` +
        (counts.info > 0
          ? styler.s('dim', `  ${plural(counts.info, 'info-level note')} below.`)
          : ''),
    )
  } else {
    worst.forEach((diagnostic, index) => {
      lines.push(
        ...renderDiagnostic(styler, diagnostic, width, {
          firstIndent: `  ${index + 1}. `,
          restIndent: '     ',
          fallbackTarget: '(surface)',
        }),
      )
    })
    const remaining = loud - worst.length
    if (remaining > 0) {
      const noun = remaining === 1 ? 'error or warning' : 'errors and warnings'
      lines.push(`  ${styler.s('dim', `${formatInteger(remaining)} more ${noun} below.`)}`)
    }
  }

  lines.push('')
  lines.push(
    heading(styler, 'Context cost') +
      `  ${styler.s('dim', `~${formatInteger(report.tokens.total)} tokens total, ${report.tokens.serialization}`)}`,
  )
  const byCost = [...report.surface.tools].sort((a, b) => b.tokens.total - a.tokens.total)
  const shown = byCost.slice(0, maxTools)
  lines.push(...renderTable(TOKEN_COLUMNS, tokenRows(shown), { indent: '  ', styler }))
  if (byCost.length > shown.length) {
    const hidden = byCost.slice(shown.length)
    const hiddenTokens = hidden.reduce((sum, tool) => sum + tool.tokens.total, 0)
    lines.push(
      `  ${styler.s('dim', `${plural(hidden.length, 'more tool')} not shown, ~${formatInteger(hiddenTokens)} tokens (${formatPercent(report.tokens.total > 0 ? hiddenTokens / report.tokens.total : 0)}).`)}`,
    )
  }
  if (!report.tokens.tokenizer.exact) {
    lines.push(
      ...wrap(report.tokens.tokenizer.note, width, `  ${styler.s('dim', '')}`).map((line) =>
        styler.s('dim', line),
      ),
    )
  }

  // Annotations
  const coverage = report.annotations.coverage
  lines.push('')
  lines.push(
    heading(styler, 'Annotations') +
      `  ${styler.s('dim', `${coverage.annotated}/${coverage.toolCount} tools annotated`)}`,
  )
  lines.push(
    '  ' +
      (['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const)
        .map((hint) => `${hint} ${coverage.byHint[hint]}/${coverage.toolCount}`)
        .join('   '),
  )
  lines.push(...wrap(report.annotations.caveat, width, '  ').map((line) => styler.s('dim', line)))

  // Lexical overlap
  lines.push('')
  const notable = report.overlap.pairs.filter((pair) => pair.score >= NOTABLE_OVERLAP)
  lines.push(
    heading(styler, 'Lexical overlap') +
      `  ${styler.s('dim', `${plural(report.overlap.pairsConsidered, 'pair')} scored`)}`,
  )
  if (report.surface.toolCount < 2) {
    lines.push(`  ${styler.s('dim', 'Fewer than two tools: there is nothing to compare.')}`)
  } else if (notable.length === 0) {
    const best = report.overlap.pairs[0]
    lines.push(
      `  ${styler.s('green', `No pair scores at or above ${NOTABLE_OVERLAP.toFixed(2)}.`)}` +
        (best
          ? styler.s(
              'dim',
              ` Highest: ${best.score.toFixed(2)} (${best.tools[0]} <-> ${best.tools[1]}).`,
            )
          : ''),
    )
  } else {
    const rows = notable
      .slice(0, maxOverlapRows)
      .map((pair) => [
        pair.score.toFixed(2),
        `${pair.tools[0]} <-> ${pair.tools[1]}`,
        pair.identicalDescription
          ? 'identical description'
          : pair.distinctiveSharedTerms.join(', '),
      ])
    lines.push(
      ...renderTable(
        [
          { header: 'score', align: 'right' },
          { header: 'pair', maxWidth: 44 },
          { header: 'shared terms', maxWidth: 34 },
        ],
        rows,
        { indent: '  ', styler },
      ),
    )
    if (notable.length > rows.length) {
      lines.push(
        `  ${styler.s('dim', `${plural(notable.length - rows.length, 'more pair')} at or above ${NOTABLE_OVERLAP.toFixed(2)} not shown.`)}`,
      )
    }
    lines.push(
      ...wrap(
        'Overlap predicts confusion, it does not measure it. `whichtool run` puts these pairs in front of a model and reports which ones actually get swapped.',
        width,
        '  ',
      ).map((line) => styler.s('dim', line)),
    )
  }

  lines.push('')
  lines.push(heading(styler, 'Deprecated features'))
  lines.push(
    ...wrap(report.deprecations.note, width, '  ').map((line) =>
      report.deprecations.checked ? styler.s('dim', line) : styler.s('yellow', line),
    ),
  )
  for (const diagnostic of report.deprecations.diagnostics) {
    lines.push(...renderDiagnostic(styler, diagnostic, width, { fallbackTarget: '(surface)' }))
  }

  lines.push('')
  lines.push(
    heading(styler, 'Findings') +
      `  ${styler.s('dim', `${plural(counts.error, 'error')}, ${plural(counts.warning, 'warning')}, ${counts.info} info`)}`,
  )
  if (report.diagnostics.length === 0) {
    lines.push(`  ${styler.s('green', 'None.')}`)
  } else {
    for (const diagnostic of report.diagnostics) {
      lines.push(...renderDiagnostic(styler, diagnostic, width, { fallbackTarget: '(surface)' }))
    }
  }

  // Thresholds
  if (report.thresholds.length > 0) {
    lines.push('')
    lines.push(heading(styler, 'Thresholds'))
    for (const check of report.thresholds) {
      const verdict = check.ok ? styler.s('green', 'pass') : styler.s('red', 'FAIL')
      lines.push(
        `  ${verdict}  ${check.name}  ${formatInteger(check.actual)} / ${formatInteger(check.limit)}`,
      )
    }
  }

  lines.push('')
  lines.push(styler.s('dim', 'No tool was executed. whichtool read tools/list and stopped there.'))
  return lines.join('\n')
}
