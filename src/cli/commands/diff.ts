import { diffRuns, parseRunReport } from '../../core/diff.js'
import { WhichtoolError } from '../../core/errors.js'
import { renderDiffMarkdown, renderDiffTerminal } from '../../core/report/diff-terminal.js'
import type { Runtime } from '../../runtime/types.js'
import { parseArgs, renderHelp, type FlagSpecs } from '../args.js'
import { decideColor } from '../render.js'

export const DIFF_FLAGS: FlagSpecs = {
  format: { type: 'string', description: 'terminal | json | markdown', placeholder: 'name' },
  out: { type: 'string', description: 'Write to this file instead of stdout', placeholder: 'file' },
  'max-accuracy-drop': {
    type: 'number',
    description: 'Exit 1 when a paired, distinguishable accuracy drop exceeds this',
    placeholder: 'f',
  },
  color: { type: 'boolean', description: 'Force colour on; --no-color forces it off' },
  help: { type: 'boolean', alias: 'h', description: 'Show this help' },
}

const USAGE = `whichtool diff <base.json> <head.json>

  Compare two saved runs. The intended use is a pull request: run the base branch, run the
  branch under review, and diff them.

  Deltas are only shown when the two runs measured the same thing. A different model,
  endpoint, seed, provider capabilities, temperature, repeat count, permutation setting,
  or selected tasks makes them incomparable, and this says so rather than subtracting
  numbers that do not belong together.

  Matched task/trial outcomes are compared with an exact two-sided paired sign test. A
  movement with p > 0.05 is reported as inconclusive rather than called a regression.
`

async function loadRun(runtime: Runtime, source: string) {
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
  return parseRunReport(payload, source)
}

export async function runDiff(runtime: Runtime, argv: readonly string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, DIFF_FLAGS)

  if (flags['help'] === true) {
    runtime.writeOut(renderHelp(USAGE, DIFF_FLAGS))
    return 0
  }
  if (positionals.length !== 2) {
    throw new WhichtoolError(
      'cli/bad-arguments',
      `\`diff\` takes exactly two saved runs, got ${positionals.length}.`,
      'Produce them with `whichtool run ... --format json --out run.json`.',
    )
  }

  const base = await loadRun(runtime, positionals[0] as string)
  const head = await loadRun(runtime, positionals[1] as string)

  const options =
    flags['max-accuracy-drop'] === undefined
      ? {}
      : { maxAccuracyDrop: flags['max-accuracy-drop'] as number }
  const diff = diffRuns(base, head, options)

  const format = (flags['format'] as string | undefined) ?? 'terminal'
  const outPath = flags['out'] as string | undefined
  const color = decideColor(runtime, {
    format,
    outPath,
    colorFlag: flags['color'] as boolean | undefined,
  })

  let rendered: string
  switch (format) {
    case 'json':
      rendered = `${JSON.stringify(diff, null, 2)}\n`
      break
    case 'markdown':
      rendered = renderDiffMarkdown(diff)
      break
    case 'terminal':
      rendered = `${renderDiffTerminal(diff, { color, width: runtime.terminalWidth() ?? 88 })}\n`
      break
    default:
      throw new WhichtoolError(
        'cli/unsupported-format',
        `\`--format ${format}\` is not available for \`diff\`.`,
        'Available: terminal, json, markdown.',
      )
  }

  if (outPath === undefined) {
    runtime.writeOut(rendered)
  } else {
    await runtime.writeTextFile(runtime.resolve(outPath), rendered)
    runtime.writeErr(`Wrote ${format} diff to ${outPath}\n`)
  }

  // Incomparable runs are an execution error, not a threshold violation: nothing was gated,
  // the question itself was malformed.
  if (!diff.comparable) return 2
  return diff.ok ? 0 : 1
}
