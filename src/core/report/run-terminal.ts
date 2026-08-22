import type { Proportion, RunMetrics } from '../eval/metrics.js'
import { MULTI_CALL, NONE, PHANTOM } from '../eval/metrics.js'
import type { RunReport } from '../run.js'
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

export interface RunTerminalOptions {
  color: boolean
  width?: number
  maxToolRows?: number
  maxMatrixColumns?: number
}

export function formatProportion(value: Proportion, digits = 0): string {
  if (value.denominator === 0) return 'n/a (0 trials)'
  const fraction = `${value.numerator}/${value.denominator}`
  const percent = formatPercent(value.value, digits)
  if (value.ci95 === null) return `${fraction}  ${percent}`
  return `${fraction}  ${percent}  [${formatPercent(value.ci95[0], digits)}-${formatPercent(value.ci95[1], digits)}]`
}

/**
 * The confusion matrix, compactly.
 *
 * Full tool names down the side, numbered columns across the top with a legend. A grid of
 * truncated names is unreadable past four tools, and this stays legible at twenty.
 */
function renderConfusionMatrix(styler: Styler, metrics: RunMetrics, maxColumns: number): string[] {
  const rows = Object.keys(metrics.confusionMatrix)
    .filter((name) => name !== NONE)
    .sort()
  if (rows.length === 0) return [`  ${styler.s('dim', 'No scored trials expected a tool.')}`]

  const picked = new Set<string>()
  for (const row of Object.values(metrics.confusionMatrix)) {
    for (const name of Object.keys(row)) picked.add(name)
  }
  const columns = [...picked]
    .filter((name) => name !== NONE && name !== PHANTOM && name !== MULTI_CALL)
    .sort()
  const shown = columns.slice(0, maxColumns)

  const header = [
    'expected \\ picked',
    ...shown.map((_, index) => String(index + 1)),
    '-',
    '?',
    '+',
  ]
  const body = rows.map((expected) => {
    const row = metrics.confusionMatrix[expected] ?? {}
    return [
      expected,
      ...shown.map((name) => {
        const count = row[name] ?? 0
        if (count === 0) return '.'
        return name === expected ? styler.s('green', String(count)) : styler.s('red', String(count))
      }),
      String(row[NONE] ?? 0),
      String(row[PHANTOM] ?? 0),
      String(row[MULTI_CALL] ?? 0),
    ]
  })

  const spec: Column[] = header.map((label, index) => ({
    header: label,
    align: index === 0 ? 'left' : 'right',
    ...(index === 0 ? { maxWidth: 32 } : {}),
  }))

  const lines = renderTable(spec, body, { indent: '  ', styler })
  lines.push(
    `  ${styler.s('dim', `columns: ${shown.map((name, index) => `${index + 1}=${name}`).join('  ')}`)}`,
  )
  if (columns.length > shown.length) {
    lines.push(
      `  ${styler.s('dim', `${columns.length - shown.length} more picked tools not shown.`)}`,
    )
  }
  lines.push(
    `  ${styler.s('dim', '- = no call, ? = a tool name that does not exist, + = multiple calls')}`,
  )
  return lines
}

export function renderRunTerminal(report: RunReport, options: RunTerminalOptions): string {
  report = sanitizeTextValue(report)
  const styler = createStyler(options.color)
  const width = options.width ?? 88
  const maxToolRows = options.maxToolRows ?? 20
  const metrics = report.metrics
  const lines: string[] = []
  const repro = report.reproducibility
  const diagnosticErrors = report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  ).length

  lines.push(styler.s('bold', 'whichtool run'))
  lines.push(`  ${styler.s('dim', 'target  ')}  ${report.target.transport}  ${report.target.ref}`)
  lines.push(
    `  ${styler.s('dim', 'surface ')}  ${shortHash(repro.surfaceHash)}  ` +
      `${plural(report.metrics.byTool.length, 'tool')}  ` +
      `~${formatInteger(report.contextCost.total)} tokens ${report.contextCost.tokenizer.exact ? '' : '(estimate)'}`.trimEnd(),
  )
  lines.push(
    `  ${styler.s('dim', 'provider')}  ${repro.provider}  ${repro.model}` +
      (repro.endpoint === null ? '' : `  ${styler.s('dim', repro.endpoint)}`),
  )
  lines.push(
    `  ${styler.s('dim', 'trials  ')}  ${formatInteger(metrics.trials.planned)} = ` +
      `${plural(report.tasks.selected, 'task')} x ${repro.repeat} repeats, ` +
      `${repro.permuted ? 'permuted' : styler.s('yellow', 'NOT permuted')}, ` +
      `temperature ${repro.temperature}, seed ${repro.seed}, ` +
      `${(report.durationMs / 1000).toFixed(0)}s`,
  )
  lines.push(
    `  ${styler.s('dim', 'status  ')}  ` +
      (!report.execution.ok
        ? styler.s(
            'red',
            `INVALID (${report.execution.scored}/${report.execution.planned} scored; ${formatPercent(report.execution.errorRate.value)} unavailable, max ${formatPercent(report.execution.maxErrorRate)})`,
          )
        : !report.ok
          ? styler.s('red', `FAILED (${plural(diagnosticErrors, 'error diagnostic')})`)
          : styler.s(
              'green',
              `valid (${report.execution.scored}/${report.execution.planned} scored)`,
            )),
  )

  // worst first
  const loud = report.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info')
  lines.push('')
  lines.push(styler.s('bold', 'Worst first'))
  if (loud.length === 0) {
    lines.push(`  ${styler.s('green', 'No errors or warnings.')}`)
  } else {
    loud.slice(0, 3).forEach((diagnostic, index) => {
      lines.push(
        ...renderDiagnostic(styler, diagnostic, width, {
          firstIndent: `  ${index + 1}. `,
          restIndent: '     ',
          fallbackTarget: '(run)',
        }),
      )
    })
    if (loud.length > 3) {
      lines.push(`  ${styler.s('dim', `${loud.length - 3} more below.`)}`)
    }
  }

  lines.push('')
  lines.push(styler.s('bold', 'Accuracy'))
  lines.push(`  ${'single-call'.padEnd(14)}${formatProportion(metrics.accuracy)}`)
  lines.push(`  ${'abstention'.padEnd(14)}${formatProportion(metrics.abstention)}`)
  // Deliberately adjacent: optimising one of these worsens the other, and a report that
  // separates them invites exactly that mistake (SPEC §5.6).
  lines.push(`  ${'over-trigger'.padEnd(14)}${formatProportion(metrics.overTrigger)}`)
  lines.push(`  ${'phantom'.padEnd(14)}${formatProportion(metrics.phantom)}`)
  lines.push(`  ${'multi-call'.padEnd(14)}${formatProportion(metrics.multiCallRate)}`)
  lines.push(`  ${'clarified'.padEnd(14)}${formatProportion(metrics.clarification)}`)
  lines.push(
    `  ${'errors'.padEnd(14)}${metrics.trials.errored}/${metrics.trials.planned}  ` +
      styler.s('dim', '(excluded from every rate above)'),
  )

  // per tool
  lines.push('')
  lines.push(styler.s('bold', 'Per tool') + `  ${styler.s('dim', 'worst first')}`)
  const toolRows = metrics.byTool
    .slice(0, maxToolRows)
    .map((tool) => [
      tool.tool,
      tool.accuracy.denominator === 0 ? 'no tasks' : formatProportion(tool.accuracy),
      tool.confusedWith.length === 0
        ? ''
        : tool.confusedWith.map((item) => `${item.tool} x${item.count}`).join(', '),
      tool.argumentAccuracy.denominator === 0 ? '-' : formatProportion(tool.argumentAccuracy),
      `~${formatInteger(tool.contextTokens)}`,
    ])
  lines.push(
    ...renderTable(
      [
        { header: 'tool', maxWidth: 28 },
        { header: 'single-call  (95% CI)' },
        { header: 'confused with', maxWidth: 30 },
        { header: 'args ok' },
        { header: 'tokens', align: 'right' },
      ],
      toolRows,
      { indent: '  ', styler },
    ),
  )
  if (metrics.byTool.length > toolRows.length) {
    lines.push(
      `  ${styler.s('dim', `${metrics.byTool.length - toolRows.length} more tools not shown.`)}`,
    )
  }

  lines.push('')
  lines.push(styler.s('bold', 'Confusion matrix'))
  lines.push(...renderConfusionMatrix(styler, metrics, options.maxMatrixColumns ?? 12))

  lines.push('')
  lines.push(styler.s('bold', 'Confusion pairs') + `  ${styler.s('dim', 'the fix list, in order')}`)
  if (metrics.confusionPairs.length === 0) {
    lines.push(
      `  ${styler.s('green', 'No tool was ever picked when a different one was expected.')}`,
    )
  } else {
    lines.push(
      ...renderTable(
        [
          { header: 'swaps', align: 'right' },
          { header: 'pair', maxWidth: 44 },
          { header: 'rate' },
          { header: 'direction' },
        ],
        metrics.confusionPairs.map((pair) => [
          String(pair.swaps),
          `${pair.tools[0]} <-> ${pair.tools[1]}`,
          formatProportion(pair.rate),
          `${pair.tools[0]}<-${pair.bChosenWhenAExpected}  ${pair.tools[1]}<-${pair.aChosenWhenBExpected}`,
        ]),
        { indent: '  ', styler },
      ),
    )
  }

  // position sensitivity
  lines.push('')
  lines.push(styler.s('bold', 'Position sensitivity'))
  if (!repro.permuted) {
    lines.push(`  ${styler.s('yellow', 'Not measurable: tool order was not permuted.')}`)
  } else if (metrics.position.spread === null) {
    lines.push(
      `  ${styler.s('dim', 'Not measurable: no task was tried at more than one position. Raise --repeat.')}`,
    )
  } else {
    lines.push(
      `  spread ${formatPercent(metrics.position.spread)} ` +
        `${styler.s('dim', `(mean within-task, over ${plural(metrics.position.comparableTasks, 'task')})`)}`,
    )
    lines.push(
      ...renderTable(
        [{ header: 'position', align: 'right' }, { header: 'accuracy (pooled, descriptive)' }],
        metrics.position.buckets.map((bucket) => [
          String(bucket.position),
          formatProportion(bucket.accuracy),
        ]),
        { indent: '  ', styler },
      ),
    )
    lines.push(
      ...wrap(
        'The table pools tasks, so it mixes task difficulty with position. The spread above does not: it compares each task against itself.',
        width,
        '  ',
      ).map((line) => styler.s('dim', line)),
    )
  }

  const counts = { error: 0, warning: 0, info: 0 }
  for (const diagnostic of report.diagnostics) counts[diagnostic.severity] += 1
  lines.push('')
  lines.push(
    styler.s('bold', 'Findings') +
      `  ${styler.s('dim', `${plural(counts.error, 'error')}, ${plural(counts.warning, 'warning')}, ${counts.info} info`)}`,
  )
  if (report.diagnostics.length === 0) lines.push(`  ${styler.s('green', 'None.')}`)
  for (const diagnostic of report.diagnostics) {
    lines.push(...renderDiagnostic(styler, diagnostic, width, { fallbackTarget: '(run)' }))
  }

  // thresholds
  if (report.thresholds.length > 0) {
    lines.push('')
    lines.push(styler.s('bold', 'Thresholds'))
    for (const check of report.thresholds) {
      lines.push(
        `  ${check.ok ? styler.s('green', 'pass') : styler.s('red', 'FAIL')}  ${check.name}  ` +
          `${check.actual.toFixed(3)} / ${check.limit}`,
      )
    }
  }

  lines.push('')
  lines.push(styler.s('dim', 'No tool was executed. whichtool read tools/list and stopped there.'))
  return lines.join('\n')
}
