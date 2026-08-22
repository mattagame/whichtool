import { WhichtoolError } from '../../core/errors.js'
import { createStyler, renderDiagnostic, sortDiagnostics } from '../../core/report/format.js'
import { loadSurface } from '../../core/surface/fetch.js'
import { parseTaskSet } from '../../core/tasks/load.js'
import { validateTaskSet } from '../../core/tasks/validate.js'
import type { Surface } from '../../core/types.js'
import type { Runtime } from '../../runtime/types.js'
import { parseArgs, renderHelp, type FlagSpecs } from '../args.js'
import { loadConfig } from '../config-loader.js'
import { resolveTaskFile, toDisplayPath } from '../paths.js'
import { decideColor } from '../render.js'
import { openTarget } from '../target.js'

export const TASKS_LINT_FLAGS: FlagSpecs = {
  tasks: { type: 'string', description: 'Task set file (.yaml or .json)', placeholder: 'file' },
  transport: { type: 'string', description: 'snapshot | http | stdio', placeholder: 'name' },
  config: { type: 'string', description: 'Path to a whichtool config file', placeholder: 'file' },
  format: { type: 'string', description: 'terminal | json', placeholder: 'name' },
  color: { type: 'boolean', description: 'Force colour on; --no-color forces it off' },
  help: { type: 'boolean', alias: 'h', description: 'Show this help' },
}

const USAGE = `whichtool tasks lint [target]

  Validate a task set: duplicate ids, expected tools that are not on the surface, missing
  distractors, and coverage too thin to draw a conclusion from.

  A target is optional. Without one the checks that need the surface are skipped, and the
  report says which ones those were.
`

export async function runTasksLint(runtime: Runtime, argv: readonly string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, TASKS_LINT_FLAGS)

  if (flags['help'] === true) {
    runtime.writeOut(renderHelp(USAGE, TASKS_LINT_FLAGS))
    return 0
  }

  const config = await loadConfig(runtime, flags['config'] as string | undefined)
  const taskFile = await resolveTaskFile(
    runtime,
    flags['tasks'] as string | undefined,
    config.tasks,
  )
  const displayPath = toDisplayPath(runtime, taskFile)
  const taskSet = parseTaskSet(await runtime.readTextFile(taskFile), displayPath)

  let surface: Surface | null = null
  const hasTarget = positionals.length > 0 || config.target !== undefined
  if (hasTarget) {
    const transport = await openTarget(runtime, positionals[0], {
      transport: flags['transport'] as string | undefined,
      config,
    })
    try {
      surface = await loadSurface(transport)
    } finally {
      await transport.close?.()
    }
  }

  const validation = validateTaskSet(taskSet, surface)
  const format = (flags['format'] as string | undefined) ?? 'terminal'

  if (format === 'json') {
    runtime.writeOut(
      `${JSON.stringify(
        {
          schemaVersion: 'whichtool.tasks-lint/1',
          source: displayPath,
          surfaceChecked: surface !== null,
          surfaceHash: surface?.hash ?? null,
          ok: validation.ok,
          coverage: validation.coverage,
          diagnostics: validation.diagnostics,
        },
        null,
        2,
      )}\n`,
    )
    return validation.ok ? 0 : 1
  }
  if (format !== 'terminal') {
    throw new WhichtoolError(
      'cli/unsupported-format',
      `\`--format ${format}\` is not available for \`tasks lint\`.`,
      'Implemented: terminal, json.',
    )
  }

  const styler = createStyler(
    decideColor(runtime, { colorFlag: flags['color'] as boolean | undefined }),
  )
  const width = runtime.terminalWidth() ?? 88
  const lines: string[] = []

  lines.push(styler.s('bold', 'whichtool tasks lint'))
  lines.push(`  ${styler.s('dim', 'file    ')}  ${displayPath}`)
  lines.push(
    `  ${styler.s('dim', 'tasks   ')}  ${validation.coverage.taskCount} total, ` +
      `${validation.coverage.distractorCount} distractors`,
  )
  lines.push(
    surface === null
      ? `  ${styler.s('dim', 'surface ')}  ${styler.s('yellow', 'not checked: no target given, so expected-tool and coverage checks were skipped')}`
      : `  ${styler.s('dim', 'surface ')}  ${validation.coverage.toolsCovered}/${validation.coverage.toolsOnSurface} tools covered by at least one task`,
  )

  lines.push('')
  const sorted = sortDiagnostics(validation.diagnostics)
  if (sorted.length === 0) {
    lines.push(`  ${styler.s('green', 'Nothing to report.')}`)
  }
  for (const diagnostic of sorted) {
    lines.push(...renderDiagnostic(styler, diagnostic, width))
  }

  lines.push('')
  lines.push(
    validation.ok
      ? styler.s(
          'dim',
          'No errors. Warnings do not block a run; they change how much its numbers mean.',
        )
      : styler.s('red', 'Errors present: `whichtool run` would measure the wrong thing.'),
  )
  lines.push('')

  runtime.writeOut(lines.join('\n'))
  return validation.ok ? 0 : 1
}
