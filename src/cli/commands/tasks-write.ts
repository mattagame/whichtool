import { WhichtoolError } from '../../core/errors.js'
import { ABSOLUTE_MAX_TOOLS, assertMaxTools, DEFAULT_MAX_TOOLS } from '../../core/eval/options.js'
import { createStyler, renderDiagnostic, sortDiagnostics } from '../../core/report/format.js'
import { loadSurface } from '../../core/surface/fetch.js'
import {
  generateTaskSet,
  DEFAULT_DISTRACTORS,
  DEFAULT_TASKS_PER_TOOL,
} from '../../core/tasks/generate.js'
import { parseTaskSet } from '../../core/tasks/load.js'
import { mutateTasks, MUTATION_NAMES } from '../../core/tasks/mutate.js'
import { taskSetToJson, taskSetToYaml, TASK_SET_VERSION } from '../../core/tasks/schema.js'
import type { Diagnostic } from '../../core/types.js'
import type { Runtime } from '../../runtime/types.js'
import { parseArgs, renderHelp, type FlagSpecs } from '../args.js'
import { loadConfig } from '../config-loader.js'
import { resolveTaskFile, toDisplayPath } from '../paths.js'
import { decideColor } from '../render.js'
import { createProviderFromConfig } from '../provider.js'
import { openTarget } from '../target.js'

function reportDiagnostics(
  runtime: Runtime,
  diagnostics: readonly Diagnostic[],
  width: number,
): string[] {
  const styler = createStyler(decideColor(runtime))
  return sortDiagnostics(diagnostics).flatMap((d) => renderDiagnostic(styler, d, width))
}

async function guardOutput(runtime: Runtime, out: string, force: boolean): Promise<string> {
  const absolute = runtime.resolve(out)
  if (!force && (await runtime.fileExists(absolute))) {
    throw new WhichtoolError(
      'tasks/would-overwrite',
      `${out} already exists.`,
      'A task set is committed and edited by hand; overwriting one silently would throw that work away. Pass --force if that is what you want, or --out a different file.',
    )
  }
  return absolute
}

function serialize(
  out: string,
  version: number,
  surface: string | null,
  tasks: Parameters<typeof taskSetToYaml>[0]['tasks'],
): string {
  return out.endsWith('.json')
    ? `${JSON.stringify(taskSetToJson({ version, surface, tasks }), null, 2)}\n`
    : taskSetToYaml({ version, surface, tasks })
}

// tasks generate
export const TASKS_GENERATE_FLAGS: FlagSpecs = {
  out: {
    type: 'string',
    description: 'Where to write the task set (default whichtool.tasks.yaml)',
    placeholder: 'file',
  },
  transport: { type: 'string', description: 'snapshot | http | stdio', placeholder: 'name' },
  provider: { type: 'string', description: 'Provider to generate with', placeholder: 'name' },
  model: { type: 'string', description: 'Model id', placeholder: 'id' },
  'base-url': {
    type: 'string',
    description: 'Endpoint for an OpenAI-compatible provider',
    placeholder: 'url',
  },
  'tasks-per-tool': {
    type: 'number',
    description: `Requests to write per tool (default ${DEFAULT_TASKS_PER_TOOL})`,
    placeholder: 'n',
  },
  'max-tools': {
    type: 'number',
    description: `Maximum tools shown to the generator (default ${DEFAULT_MAX_TOOLS}; hard max ${ABSOLUTE_MAX_TOOLS})`,
    placeholder: 'n',
  },
  distractors: {
    type: 'number',
    description: `Distractors to write (default ${DEFAULT_DISTRACTORS})`,
    placeholder: 'n',
  },
  temperature: {
    type: 'number',
    description: 'Sampling temperature (default 0.7)',
    placeholder: 'f',
  },
  force: { type: 'boolean', description: 'Overwrite an existing task set' },
  config: { type: 'string', description: 'Path to a whichtool config file', placeholder: 'file' },
  help: { type: 'boolean', alias: 'h', description: 'Show this help' },
}

const GENERATE_USAGE = `whichtool tasks generate <target>

  Draft a task set from the server's own tool descriptions, distractors included.

  The result is written to a file for you to read, edit and commit. It is deliberately not
  regenerated on each run: generation is non-deterministic and execution must not be.

  Treat the output as a first draft. The model writes plausible requests; only you know
  which ones your users actually ask.
`

export async function runTasksGenerate(runtime: Runtime, argv: readonly string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, TASKS_GENERATE_FLAGS)
  if (flags['help'] === true) {
    runtime.writeOut(renderHelp(GENERATE_USAGE, TASKS_GENERATE_FLAGS))
    return 0
  }

  const config = await loadConfig(runtime, flags['config'] as string | undefined)
  const out = (flags['out'] as string | undefined) ?? config.tasks ?? 'whichtool.tasks.yaml'
  const absoluteOut = await guardOutput(runtime, out, flags['force'] === true)

  const transport = await openTarget(runtime, positionals[0], {
    transport: flags['transport'] as string | undefined,
    config,
  })

  try {
    const surface = await loadSurface(transport)
    const maxTools = assertMaxTools(
      (flags['max-tools'] as number | undefined) ?? config.trials?.maxTools ?? DEFAULT_MAX_TOOLS,
    )
    if (surface.tools.length > maxTools) {
      throw new WhichtoolError(
        'generate/tool-limit',
        `Surface exposes ${surface.tools.length} tools, above the configured generator limit of ${maxTools}.`,
        `Inspect the surface first, then pass --max-tools ${surface.tools.length} if generating across the whole surface is intentional.`,
      )
    }
    const provider = createProviderFromConfig(runtime, {
      config: config.provider,
      name: flags['provider'] as string | undefined,
      model: flags['model'] as string | undefined,
      baseUrl: flags['base-url'] as string | undefined,
    })

    runtime.writeErr(
      `Asking ${provider.id}/${provider.model} for a draft over ${surface.tools.length} tools...\n`,
    )

    const result = await generateTaskSet(provider, surface, {
      ...(flags['tasks-per-tool'] === undefined
        ? {}
        : { tasksPerTool: flags['tasks-per-tool'] as number }),
      ...(flags['distractors'] === undefined
        ? {}
        : { distractors: flags['distractors'] as number }),
      ...(flags['temperature'] === undefined
        ? {}
        : { temperature: flags['temperature'] as number }),
    })

    await runtime.writeTextFile(
      absoluteOut,
      serialize(out, TASK_SET_VERSION, surface.hash, result.tasks),
    )

    const distractors = result.tasks.filter((task) => task.expected === null).length
    const lines = [
      `Wrote ${result.tasks.length} tasks (${distractors} distractors) to ${out}`,
      '',
      ...reportDiagnostics(runtime, result.diagnostics, runtime.terminalWidth() ?? 88),
      '',
      '  This is a draft. Read it before committing it, and check the distractors hardest:',
      '  a distractor that any model would refuse measures nothing.',
      '',
      `  Then: whichtool tasks lint ${positionals[0] ?? ''}`.trimEnd(),
      '',
    ]
    runtime.writeOut(lines.join('\n'))
    return 0
  } finally {
    await transport.close?.()
  }
}

// tasks mutate
export const TASKS_MUTATE_FLAGS: FlagSpecs = {
  tasks: { type: 'string', description: 'Task set to mutate', placeholder: 'file' },
  out: { type: 'string', description: 'Where to write the result', placeholder: 'file' },
  mutations: {
    type: 'string',
    description: `Comma-separated: ${MUTATION_NAMES.join(',')}`,
    placeholder: 'list',
  },
  seed: {
    type: 'number',
    description: 'Seed, so the variants are identical everywhere (default 0)',
    placeholder: 'n',
  },
  originals: {
    type: 'boolean',
    description: 'Keep the originals alongside the variants (default on)',
  },
  force: { type: 'boolean', description: 'Overwrite an existing file' },
  config: { type: 'string', description: 'Path to a whichtool config file', placeholder: 'file' },
  help: { type: 'boolean', alias: 'h', description: 'Show this help' },
}

const MUTATE_USAGE = `whichtool tasks mutate

  Derive robustness variants from an existing task set: typos, a curt chat-box register, an
  over-polite one, and questions turned into commands and back.

  Purely textual and seeded, so no model is involved and the same variants come out on every
  machine. Each variant keeps its original's expected tool, so one the model gets wrong is a
  robustness failure rather than an ambiguity.

  A mutation that cannot convert a prompt cleanly skips it and says how many it skipped.
`

export async function runTasksMutate(runtime: Runtime, argv: readonly string[]): Promise<number> {
  const { flags } = parseArgs(argv, TASKS_MUTATE_FLAGS)
  if (flags['help'] === true) {
    runtime.writeOut(renderHelp(MUTATE_USAGE, TASKS_MUTATE_FLAGS))
    return 0
  }

  const config = await loadConfig(runtime, flags['config'] as string | undefined)
  const source = await resolveTaskFile(runtime, flags['tasks'] as string | undefined, config.tasks)

  const out = flags['out'] as string | undefined
  if (out === undefined) {
    throw new WhichtoolError(
      'cli/missing-argument',
      '`tasks mutate` needs --out.',
      'It will not write over the set it just read; the originals are the authoritative ones.',
    )
  }
  const absoluteOut = await guardOutput(runtime, out, flags['force'] === true)

  const taskSet = parseTaskSet(await runtime.readTextFile(source), toDisplayPath(runtime, source))
  const requested = (flags['mutations'] as string | undefined)
    ?.split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')

  for (const name of requested ?? []) {
    if (MUTATION_NAMES.includes(name)) continue
    throw new WhichtoolError(
      'tasks/unknown-mutation',
      `Unknown mutation \`${name}\`.`,
      `Available: ${MUTATION_NAMES.join(', ')}.`,
    )
  }

  const result = mutateTasks(taskSet.tasks, {
    ...(requested === undefined ? {} : { mutations: requested }),
    ...(flags['seed'] === undefined ? {} : { seed: flags['seed'] as number }),
    ...(flags['originals'] === false ? { keepOriginals: false } : {}),
  })

  await runtime.writeTextFile(
    absoluteOut,
    serialize(out, taskSet.version, taskSet.surface, result.tasks),
  )

  const rows = Object.entries(result.applied)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([name, stats]) =>
        `  ${name.padEnd(14)} ${stats.produced} produced, ${stats.skipped} skipped`,
    )

  runtime.writeOut(
    [
      `Wrote ${result.tasks.length} tasks to ${out}`,
      '',
      ...rows,
      '',
      ...reportDiagnostics(runtime, result.diagnostics, runtime.terminalWidth() ?? 88),
      '',
    ].join('\n'),
  )
  return 0
}
