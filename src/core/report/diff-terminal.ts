import type { RunDiff } from '../diff.js'
import type { Proportion } from '../eval/metrics.js'
import { shortHash } from '../surface/hash.js'
import {
  createStyler,
  formatInteger,
  renderDiagnostic,
  renderTable,
  wrap,
  type StyleName,
  type Styler,
} from './format.js'
import { formatProportion } from './run-terminal.js'
import { sanitizeTextValue } from './sanitize.js'

export interface DiffTerminalOptions {
  color: boolean
  width?: number
}

function formatDelta(delta: number | null, distinguishable: boolean): string {
  if (delta === null) return 'n/a'
  const points = Math.round(delta * 100)
  const sign = points > 0 ? `+${points}` : String(points)
  return distinguishable ? `${sign} pts` : `${sign} pts (inconclusive)`
}

function deltaStyle(delta: number | null, distinguishable: boolean, inverted = false): StyleName {
  if (delta === null || delta === 0 || !distinguishable) return 'dim'
  const better = inverted ? delta < 0 : delta > 0
  return better ? 'green' : 'red'
}

/**
 * A summary row: label, both rates, and the delta coloured by whether it is an improvement.
 *
 * `inverted` is what makes over-trigger readable next to accuracy: a drop in over-trigger is
 * good and a drop in accuracy is bad, so the same green cannot mean "went up" in both rows.
 */
function line(
  styler: Styler,
  label: string,
  before: Proportion,
  after: Proportion,
  delta: number | null,
  distinguishable: boolean,
  inverted = false,
): string[] {
  return [
    label,
    formatProportion(before),
    formatProportion(after),
    styler.s(deltaStyle(delta, distinguishable, inverted), formatDelta(delta, distinguishable)),
  ]
}

export function renderDiffTerminal(diff: RunDiff, options: DiffTerminalOptions): string {
  diff = sanitizeTextValue(diff)
  const styler = createStyler(options.color)
  const width = options.width ?? 88
  const lines: string[] = []

  lines.push(styler.s('bold', 'whichtool diff'))
  lines.push(
    `  ${styler.s('dim', 'base')}  ${diff.base.provider}/${diff.base.model}  ` +
      `surface ${shortHash(diff.base.surfaceHash)}  repeat ${diff.base.repeat}`,
  )
  lines.push(
    `  ${styler.s('dim', 'head')}  ${diff.head.provider}/${diff.head.model}  ` +
      `surface ${shortHash(diff.head.surfaceHash)}  repeat ${diff.head.repeat}`,
  )

  lines.push('')
  if (!diff.comparable) {
    lines.push(styler.s('red', 'These runs are not comparable. The deltas below are omitted.'))
    for (const reason of diff.incomparable) {
      lines.push(...wrap(`- ${reason}`, width, '  '))
    }
  } else {
    lines.push(
      ...renderTable(
        [{ header: 'metric' }, { header: 'base' }, { header: 'head' }, { header: 'delta' }],
        [
          line(
            styler,
            'single-call',
            diff.accuracy.before,
            diff.accuracy.after,
            diff.accuracy.delta,
            diff.accuracy.distinguishable,
          ),
          line(
            styler,
            'over-trigger',
            diff.overTrigger.before,
            diff.overTrigger.after,
            diff.overTrigger.delta,
            diff.overTrigger.distinguishable,
            true,
          ),
          line(
            styler,
            'multi-call',
            diff.multiCall.before,
            diff.multiCall.after,
            diff.multiCall.delta,
            diff.multiCall.distinguishable,
            true,
          ),
        ],
        { indent: '  ', styler },
      ),
    )
    lines.push(
      `  ${styler.s('dim', 'context')}  ~${formatInteger(diff.contextTokens.before)} -> ~${formatInteger(diff.contextTokens.after)} tokens ` +
        styler.s(
          diff.contextTokens.delta > 0 ? 'yellow' : 'dim',
          `(${diff.contextTokens.delta >= 0 ? '+' : ''}${formatInteger(diff.contextTokens.delta)})`,
        ),
    )
    lines.push(
      ...wrap(
        'A delta marked (inconclusive) did not pass the paired sign test at p <= 0.05. Repeats are matched by task and trial index.',
        width,
        '  ',
      ).map((text) => styler.s('dim', text)),
    )
  }

  // per tool
  const moved = diff.byTool.filter((tool) => tool.delta === null || tool.delta !== 0)
  lines.push('')
  lines.push(styler.s('bold', 'Per tool') + `  ${styler.s('dim', 'biggest drop first')}`)
  if (moved.length === 0) {
    lines.push(`  ${styler.s('green', 'No tool changed.')}`)
  } else {
    lines.push(
      ...renderTable(
        [
          { header: 'tool', maxWidth: 28 },
          { header: 'base' },
          { header: 'head' },
          { header: 'delta' },
        ],
        moved.map((tool) => [
          tool.tool,
          tool.before === null ? 'absent' : formatProportion(tool.before),
          tool.after === null ? 'absent' : formatProportion(tool.after),
          styler.s(
            deltaStyle(tool.delta, tool.distinguishable),
            formatDelta(tool.delta, tool.distinguishable),
          ),
        ]),
        { indent: '  ', styler },
      ),
    )
  }

  // confusions
  lines.push('')
  lines.push(styler.s('bold', 'Confusions'))
  if (diff.newConfusions.length === 0 && diff.resolvedConfusions.length === 0) {
    lines.push(`  ${styler.s('dim', 'No pair appeared or disappeared.')}`)
  }
  for (const pair of diff.newConfusions) {
    lines.push(
      `  ${styler.s(pair.distinguishable ? 'red' : 'yellow', 'new     ')} ${pair.tools[0]} <-> ${pair.tools[1]}  ${styler.s('dim', `${pair.swaps}/${pair.denominator} swaps; p=${pair.pValue.toFixed(4)}`)}`,
    )
  }
  for (const pair of diff.resolvedConfusions) {
    lines.push(
      `  ${styler.s('green', 'resolved')} ${pair.tools[0]} <-> ${pair.tools[1]}  ${styler.s('dim', `was ${pair.swaps} swaps`)}`,
    )
  }

  if (diff.diagnostics.length > 0) {
    lines.push('')
    lines.push(styler.s('bold', 'Findings'))
    for (const diagnostic of diff.diagnostics) {
      lines.push(...renderDiagnostic(styler, diagnostic, width))
    }
  }

  lines.push('')
  lines.push(
    !diff.comparable
      ? styler.s('red', 'No verdict: the runs are not comparable.')
      : diff.ok
        ? styler.s('dim', 'No regression detected.')
        : styler.s('red', 'Regression detected.'),
  )
  return lines.join('\n')
}

export function renderDiffMarkdown(diff: RunDiff): string {
  diff = sanitizeTextValue(diff)
  const arrow = (delta: number | null, distinguishable: boolean, inverted = false): string => {
    if (delta === null) return '—'
    const points = Math.round(delta * 100)
    if (points === 0) return 'no change'
    const better = inverted ? delta < 0 : delta > 0
    const icon = !distinguishable ? '➖' : better ? '🟢' : '🔴'
    return `${icon} ${points > 0 ? '+' : ''}${points} pts${distinguishable ? '' : ' *(paired result inconclusive)*'}`
  }

  const lines: string[] = [
    '## whichtool diff',
    '',
    `\`${diff.base.provider}/${diff.base.model}\` · base surface \`${shortHash(diff.base.surfaceHash)}\` → head surface \`${shortHash(diff.head.surfaceHash)}\``,
    '',
  ]

  if (!diff.comparable) {
    lines.push('❌ **These runs are not comparable.**', '')
    for (const reason of diff.incomparable) lines.push(`- ${reason}`)
    lines.push('')
    return lines.join('\n')
  }

  lines.push(
    diff.ok ? '✅ **No regression.**' : '❌ **Regression detected.**',
    '',
    '| metric | base | head | delta |',
    '|---|---|---|---|',
    `| **single-call accuracy** | ${formatProportion(diff.accuracy.before)} | ${formatProportion(diff.accuracy.after)} | ${arrow(diff.accuracy.delta, diff.accuracy.distinguishable)} |`,
    `| over-trigger | ${formatProportion(diff.overTrigger.before)} | ${formatProportion(diff.overTrigger.after)} | ${arrow(diff.overTrigger.delta, diff.overTrigger.distinguishable, true)} |`,
    `| multi-call | ${formatProportion(diff.multiCall.before)} | ${formatProportion(diff.multiCall.after)} | ${arrow(diff.multiCall.delta, diff.multiCall.distinguishable, true)} |`,
    `| context cost | ~${formatInteger(diff.contextTokens.before)} | ~${formatInteger(diff.contextTokens.after)} | ${diff.contextTokens.delta >= 0 ? '+' : ''}${formatInteger(diff.contextTokens.delta)} tokens |`,
    '',
  )

  const moved = diff.byTool.filter((tool) => tool.delta !== 0)
  if (moved.length > 0) {
    lines.push(
      '<details><summary>Per tool</summary>',
      '',
      '| tool | base | head | delta |',
      '|---|---|---|---|',
      ...moved.map(
        (tool) =>
          `| \`${tool.tool}\` | ${tool.before === null ? '*absent*' : formatProportion(tool.before)} | ${tool.after === null ? '*absent*' : formatProportion(tool.after)} | ${arrow(tool.delta, tool.distinguishable)} |`,
      ),
      '',
      '</details>',
      '',
    )
  }

  for (const pair of diff.newConfusions) {
    lines.push(
      `- ${pair.distinguishable ? '🔴' : '🟡'} **New confusion**: \`${pair.tools[0]}\` ↔ \`${pair.tools[1]}\` (${pair.swaps}/${pair.denominator} swaps; paired p=${pair.pValue.toFixed(4)})`,
    )
  }
  for (const pair of diff.resolvedConfusions) {
    lines.push(`- 🟢 **Resolved**: \`${pair.tools[0]}\` ↔ \`${pair.tools[1]}\``)
  }

  lines.push(
    '',
    '<sub>A delta marked *paired result inconclusive* did not pass the paired sign test at ' +
      'p ≤ 0.05. Repeats are matched by task and trial index. **No tool was executed** — ' +
      'whichtool records what the model would have called.</sub>',
    '',
  )
  return lines.join('\n')
}
