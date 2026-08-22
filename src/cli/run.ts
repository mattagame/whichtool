import { CancellationError, WhichtoolError } from '../core/errors.js'
import { sanitizeText } from '../core/report/sanitize.js'
import { redactMachinePaths } from './paths.js'
import type { Runtime } from '../runtime/types.js'
import { WHICHTOOL_VERSION } from '../version.js'
import { runCache } from './commands/cache.js'
import { runDiff } from './commands/diff.js'
import { runInspect } from './commands/inspect.js'
import { runMcpServer } from './commands/mcp.js'
import { runReport } from './commands/report.js'
import { runRun } from './commands/run.js'
import { runTasksLint } from './commands/tasks.js'
import { runTasksGenerate, runTasksMutate } from './commands/tasks-write.js'

export const EXIT = { ok: 0, thresholdViolated: 1, error: 2, cancelled: 130 } as const

const COMMANDS: Record<string, string> = {
  inspect: 'Surface, token budget, annotations. No LLM, no key.',
  'tasks lint': 'Validate a task set.',
  'tasks generate': 'Draft a task set from the tool descriptions.',
  'tasks mutate': 'Derive robustness variants. Seeded, no model.',
  run: 'Execute the trials and produce the report.',
  diff: 'Compare two saved runs.',
  report: 'Re-render a saved run in another format.',
  cache: 'Inspect or clear the trial cache.',
  mcp: 'Run as an MCP server, so an agent can drive the evaluation itself.',
}

const TASKS_USAGE = [
  'whichtool tasks <lint|generate|mutate>',
  '',
  '  lint      Validate a task set against a surface.',
  '  generate  Draft a task set from the tool descriptions. Needs a provider.',
  '  mutate    Derive seeded robustness variants. No model.',
  '',
  "Run `whichtool tasks <subcommand> --help` for that subcommand's flags.",
  '',
].join('\n')

function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length))
  const rows = Object.entries(COMMANDS).map(
    ([name, summary]) => `  ${name.padEnd(width)}  ${summary}`,
  )
  return [
    `whichtool ${WHICHTOOL_VERSION} - does the model actually pick the right tool from your MCP server?`,
    '',
    'Usage:',
    '  whichtool <command> [options]',
    '',
    'Commands:',
    ...rows,
    '',
    "Run `whichtool <command> --help` for a command's flags.",
    '',
    'whichtool never executes a tool. It reads tools/list, records what a model would',
    'have called, and stops there.',
    '',
  ].join('\n')
}

/**
 * The CLI, minus process control. Returns an exit code instead of calling `exit`, so the
 * end-to-end tests can drive it with a fake runtime and assert on both output and code.
 */
export async function main(argv: readonly string[], runtime: Runtime): Promise<number> {
  try {
    const first = argv[0]

    if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
      runtime.writeOut(helpText())
      return EXIT.ok
    }
    if (first === '--version' || first === '-v') {
      runtime.writeOut(`${WHICHTOOL_VERSION}\n`)
      return EXIT.ok
    }

    switch (first) {
      case 'inspect':
        return await runInspect(runtime, argv.slice(1))
      case 'run':
        return await runRun(runtime, argv.slice(1))
      case 'tasks': {
        const sub = argv[1]
        if (sub === 'lint') return await runTasksLint(runtime, argv.slice(2))
        if (sub === 'generate') return await runTasksGenerate(runtime, argv.slice(2))
        if (sub === 'mutate') return await runTasksMutate(runtime, argv.slice(2))
        // The top-level help promises `whichtool <command> --help` for every command, so
        // the group has to answer for itself rather than reporting an unknown subcommand.
        if (sub === undefined || sub === '--help' || sub === '-h') {
          runtime.writeOut(TASKS_USAGE)
          return EXIT.ok
        }
        throw new WhichtoolError(
          'cli/unknown-subcommand',
          `Unknown subcommand \`whichtool tasks ${sub}\`.`,
          'Available: `tasks lint`, `tasks generate`, `tasks mutate`.',
        )
      }
      case 'diff':
        return await runDiff(runtime, argv.slice(1))
      case 'report':
        return await runReport(runtime, argv.slice(1))
      case 'cache':
        return await runCache(runtime, argv.slice(1))
      case 'mcp':
        return await runMcpServer(runtime, argv.slice(1))
      default:
        throw new WhichtoolError(
          'cli/unknown-command',
          `Unknown command \`${first}\`.`,
          'Run `whichtool --help` for the command list.',
        )
    }
  } catch (error) {
    const clean = (text: string): string => sanitizeText(redactMachinePaths(text, runtime.cwd()))
    if (error instanceof WhichtoolError) {
      runtime.writeErr(`whichtool: ${clean(error.message)}\n`)
      if (error.hint !== undefined) runtime.writeErr(`  ${clean(error.hint)}\n`)
      return error instanceof CancellationError ? EXIT.cancelled : EXIT.error
    }
    runtime.writeErr(
      `whichtool: ${clean(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`,
    )
    return EXIT.error
  }
  return EXIT.error
}
