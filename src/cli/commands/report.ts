import { WhichtoolError } from '../../core/errors.js'
import { parseRunReport } from '../../core/diff.js'
import type { Runtime } from '../../runtime/types.js'
import { parseArgs, renderHelp, type FlagSpecs } from '../args.js'
import { assertRunFormat, decideColor, renderRun, RUN_FORMATS } from '../render.js'

export const REPORT_FLAGS: FlagSpecs = {
  // Derived from the list `assertRunFormat` validates against, so the help cannot drift
  // out of sync with what the command actually accepts, as it had for `junit`.
  format: { type: 'string', description: RUN_FORMATS.join(' | '), placeholder: 'name' },
  out: { type: 'string', description: 'Write to this file instead of stdout', placeholder: 'file' },
  color: { type: 'boolean', description: 'Force colour on; --no-color forces it off' },
  help: { type: 'boolean', alias: 'h', description: 'Show this help' },
}

const USAGE = `whichtool report <run.json>

  Re-render a saved run in another format. Calls no model and re-reads no server: the run
  JSON is self-contained, tasks and per-trial detail included.

  Useful for turning the run your CI already did into a pull-request comment, or into the
  standalone HTML file with the navigable confusion matrix.
`

export async function runReport(runtime: Runtime, argv: readonly string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, REPORT_FLAGS)

  if (flags['help'] === true) {
    runtime.writeOut(renderHelp(USAGE, REPORT_FLAGS))
    return 0
  }

  const source = positionals[0]
  if (source === undefined) {
    throw new WhichtoolError(
      'cli/missing-argument',
      '`report` needs a saved run to re-render.',
      'Produce one with `whichtool run ... --format json --out run.json`.',
    )
  }
  if (positionals.length > 1) {
    throw new WhichtoolError(
      'cli/too-many-arguments',
      `\`report\` takes one run, got ${positionals.length}.`,
    )
  }

  const absolute = runtime.resolve(source)
  let payload: unknown
  try {
    payload = JSON.parse(await runtime.readTextFile(absolute))
  } catch (cause) {
    throw new WhichtoolError(
      'run/unreadable',
      `Cannot read ${source}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  const report = parseRunReport(payload, source)

  const format = assertRunFormat((flags['format'] as string | undefined) ?? 'terminal')
  const outPath = flags['out'] as string | undefined
  const color = decideColor(runtime, {
    format,
    outPath,
    colorFlag: flags['color'] as boolean | undefined,
  })

  const rendered = renderRun(report, format, { color, width: runtime.terminalWidth() ?? 88 })

  if (outPath === undefined) {
    runtime.writeOut(rendered)
  } else {
    const target = runtime.resolve(outPath)
    await runtime.writeTextFile(target, rendered)
    runtime.writeErr(`Wrote ${format} report to ${outPath}\n`)
  }

  // Re-rendering reports the run's own verdict; it does not re-decide it.
  if (!report.execution.ok) return 2
  return report.ok ? 0 : 1
}
