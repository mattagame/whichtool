import type { Proportion } from '../eval/metrics.js'
import { MULTI_CALL, NONE, PHANTOM } from '../eval/metrics.js'
import type { InspectReport } from '../inspect.js'
import type { RunReport } from '../run.js'
import { shortHash } from '../surface/hash.js'
import type { Diagnostic } from '../types.js'
import { formatInteger, formatPercent } from './format.js'
import { sanitizeTextValue } from './sanitize.js'

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function code(text: string): string {
  return `\`${text.replace(/`/g, '')}\``
}

const SEVERITY_ICON = { error: '🔴', warning: '🟡', info: '⚪' } as const

function diagnosticLine(diagnostic: Diagnostic): string {
  const target =
    diagnostic.tool ??
    (diagnostic.tools !== undefined && diagnostic.tools.length > 0
      ? diagnostic.tools.slice(0, 3).join(', ') +
        (diagnostic.tools.length > 3 ? ` +${diagnostic.tools.length - 3} more` : '')
      : '')
  const prefix = `${SEVERITY_ICON[diagnostic.severity]} ${code(diagnostic.code)}`
  return `- ${prefix}${target === '' ? '' : ` ${code(target)}`} — ${cell(diagnostic.message)}`
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ]
}

function rate(value: Proportion, digits = 0): string {
  if (value.denominator === 0) return 'n/a (0 trials)'
  const base = `${value.numerator}/${value.denominator} = ${formatPercent(value.value, digits)}`
  return value.ci95 === null
    ? base
    : `${base} <sub>[${formatPercent(value.ci95[0], digits)}–${formatPercent(value.ci95[1], digits)}]</sub>`
}

function details(summary: string, body: string[]): string[] {
  return ['<details>', `<summary>${summary}</summary>`, '', ...body, '', '</details>', '']
}

export function renderInspectMarkdown(report: InspectReport): string {
  report = sanitizeTextValue(report)
  const counts = { error: 0, warning: 0, info: 0 }
  for (const diagnostic of report.diagnostics) counts[diagnostic.severity] += 1

  const lines: string[] = [
    `## whichtool inspect`,
    '',
    `\`${report.target.transport}\` · ${code(report.target.ref)} · surface ${code(shortHash(report.surface.hash))} · ` +
      `${report.surface.toolCount} tools · ~${formatInteger(report.tokens.total)} tokens` +
      `${report.tokens.tokenizer.exact ? '' : ' *(estimate)*'}`,
    '',
    counts.error + counts.warning === 0
      ? '✅ **No errors or warnings.**'
      : `**${counts.error} error${counts.error === 1 ? '' : 's'}, ${counts.warning} warning${counts.warning === 1 ? '' : 's'}, ${counts.info} info.**`,
    '',
  ]

  const loud = report.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info')
  if (loud.length > 0) {
    lines.push(...loud.slice(0, 3).map(diagnosticLine), '')
  }

  if (report.headerParams.rejectedTools.length > 0) {
    lines.push(
      `> ⚠️ ${report.headerParams.rejectedTools.length} tools are excluded from \`tools/list\` by any conforming ` +
        `Streamable HTTP client because of an invalid \`x-mcp-header\`: ` +
        report.headerParams.rejectedTools.map(code).join(', ') +
        '. The model never sees them.',
      '',
    )
  }

  lines.push(
    ...details(
      `Context cost — ~${formatInteger(report.tokens.total)} tokens`,
      table(
        ['tool', 'tokens', 'share', 'description', 'schema'],
        [...report.surface.tools]
          .sort((a, b) => b.tokens.total - a.tokens.total)
          .map((tool) => [
            code(tool.name),
            `~${formatInteger(tool.tokens.total)}`,
            formatPercent(tool.tokenShare),
            `~${formatInteger(tool.tokens.description)}`,
            `~${formatInteger(tool.tokens.schema)}`,
          ]),
      ),
    ),
  )

  const notable = report.overlap.pairs.filter((pair) => pair.score >= 0.4)
  lines.push(
    ...details(
      `Lexical overlap — ${report.overlap.pairsConsidered} pairs scored, ${notable.length} notable`,
      notable.length === 0
        ? ['No pair scores at or above 0.40.']
        : table(
            ['score', 'pair', 'shared terms'],
            notable.map((pair) => [
              pair.score.toFixed(2),
              `${code(pair.tools[0])} ↔ ${code(pair.tools[1])}`,
              pair.identicalDescription
                ? '**identical description**'
                : pair.distinctiveSharedTerms.join(', '),
            ]),
          ),
    ),
  )

  if (report.diagnostics.length > 0) {
    lines.push(
      ...details(
        `All findings (${report.diagnostics.length})`,
        report.diagnostics.map(diagnosticLine),
      ),
    )
  }

  lines.push(
    '',
    '<sub>Overlap predicts confusion; it does not measure it. `whichtool run` does. ' +
      '**No tool was executed** — whichtool read `tools/list` and stopped there.</sub>',
    '',
  )
  return lines.join('\n')
}

export function renderRunMarkdown(report: RunReport): string {
  report = sanitizeTextValue(report)
  const metrics = report.metrics
  const repro = report.reproducibility
  const diagnosticErrors = report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  ).length

  const verdict = !report.execution.ok
    ? `❌ **Invalid run:** ${report.execution.scored}/${report.execution.planned} trials were scored; unavailable rate ${formatPercent(report.execution.errorRate.value)} (maximum ${formatPercent(report.execution.maxErrorRate)}).`
    : !report.thresholdsOk
      ? `❌ **${report.thresholds.filter((check) => !check.ok).length} thresholds violated.**`
      : !report.ok
        ? `❌ **Run failed:** ${diagnosticErrors} error diagnostic${diagnosticErrors === 1 ? '' : 's'}.`
        : report.thresholds.length === 0
          ? 'ℹ️ No thresholds configured; no error diagnostics.'
          : '✅ **All thresholds met.**'

  const lines: string[] = [
    `## whichtool run`,
    '',
    `${code(repro.provider)} · ${code(repro.model)} · surface ${code(shortHash(repro.surfaceHash))} · ` +
      `${metrics.trials.planned} trials (${report.tasks.selected} tasks × ${repro.repeat}) · ` +
      `temperature ${repro.temperature} · ${repro.permuted ? 'permuted' : '**not permuted**'}`,
    '',
    verdict,
    '',
    ...table(
      ['metric', 'value'],
      [
        ['**single-call accuracy**', rate(metrics.accuracy)],
        ['abstention', rate(metrics.abstention)],
        ['over-trigger', rate(metrics.overTrigger)],
        ['phantom tools', rate(metrics.phantom)],
        ['multiple calls', rate(metrics.multiCallRate)],
        [
          'failed trials',
          `${metrics.trials.errored}/${metrics.trials.planned} *(excluded from every rate)*`,
        ],
      ],
    ),
    '',
  ]

  if (metrics.confusionPairs.length > 0) {
    lines.push(
      '**Confusion pairs**, worst first — this is the fix list, in order.',
      '',
      ...table(
        ['swaps', 'pair', 'rate'],
        metrics.confusionPairs
          .slice(0, 5)
          .map((pair) => [
            String(pair.swaps),
            `${code(pair.tools[0])} ↔ ${code(pair.tools[1])}`,
            rate(pair.rate),
          ]),
      ),
      '',
    )
  }

  lines.push(
    ...details(
      'Per tool',
      table(
        ['tool', 'single-call accuracy', 'confused with', 'arguments valid', 'tokens'],
        metrics.byTool.map((tool) => [
          code(tool.tool),
          tool.accuracy.denominator === 0 ? '*no tasks*' : rate(tool.accuracy),
          tool.confusedWith.map((item) => `${code(item.tool)} ×${item.count}`).join(', '),
          tool.argumentAccuracy.denominator === 0 ? '—' : rate(tool.argumentAccuracy),
          `~${formatInteger(tool.contextTokens)}`,
        ]),
      ),
    ),
  )

  const expectedRows = Object.keys(metrics.confusionMatrix)
    .filter((name) => name !== NONE)
    .sort()
  const pickedColumns = [
    ...new Set(
      Object.values(metrics.confusionMatrix).flatMap((row) =>
        Object.keys(row).filter((name) => name !== NONE && name !== PHANTOM && name !== MULTI_CALL),
      ),
    ),
  ].sort()
  if (expectedRows.length > 0) {
    lines.push(
      ...details(
        'Confusion matrix',
        table(
          ['expected \\ picked', ...pickedColumns.map(code), 'none', 'phantom', 'multiple calls'],
          expectedRows.map((expected) => {
            const row = metrics.confusionMatrix[expected] ?? {}
            return [
              code(expected),
              ...pickedColumns.map((picked) => {
                const count = row[picked] ?? 0
                if (count === 0) return '·'
                return picked === expected ? `**${count}**` : String(count)
              }),
              String(row[NONE] ?? 0),
              String(row[PHANTOM] ?? 0),
              String(row[MULTI_CALL] ?? 0),
            ]
          }),
        ),
      ),
    )
  }

  if (metrics.position.spread !== null) {
    lines.push(
      ...details(`Position sensitivity — ${formatPercent(metrics.position.spread)}`, [
        `Mean within-task swing across positions, over ${metrics.position.comparableTasks} tasks tried at more than one position.`,
        '',
        ...table(
          ['position', 'accuracy (pooled, descriptive)'],
          metrics.position.buckets.map((bucket) => [
            String(bucket.position),
            rate(bucket.accuracy),
          ]),
        ),
      ]),
    )
  }

  if (report.diagnostics.length > 0) {
    lines.push(
      ...details(`Findings (${report.diagnostics.length})`, report.diagnostics.map(diagnosticLine)),
    )
  }

  lines.push(
    ...details(
      'Reproducibility',
      table(
        ['field', 'value'],
        [
          ['whichtool', repro.whichtoolVersion],
          ['provider', `${repro.provider} / ${repro.model}`],
          ['temperature', String(repro.temperature)],
          ['seed', String(repro.seed)],
          ['repeat', String(repro.repeat)],
          ['tool order permuted', String(repro.permuted)],
          ['surface hash', repro.surfaceHash],
          ['task set', `${repro.taskSetSource} (v${repro.taskSetVersion})`],
          ['honours a seed', String(repro.providerCapabilities.seed)],
          ['honours temperature 0', String(repro.providerCapabilities.temperatureZero)],
        ],
      ),
    ),
  )

  lines.push(
    '',
    '<sub>Rates carry their denominator and a 95% interval, because a percentage without one ' +
      'is not a measurement. **No tool was executed** — whichtool recorded what the model ' +
      'would have called.</sub>',
    '',
  )
  return lines.join('\n')
}
