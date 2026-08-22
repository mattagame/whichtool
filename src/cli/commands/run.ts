import { withCache } from '../../core/cache/provider.js'
import { CancellationError, WhichtoolError } from '../../core/errors.js'
import {
  ABSOLUTE_MAX_TOOLS,
  ABSOLUTE_MAX_TRIALS,
  assertMaxTools,
  assertMaxTrials,
  DEFAULT_MAX_TOOLS,
  DEFAULT_MAX_TRIALS,
} from '../../core/eval/options.js'
import { planTrials } from '../../core/eval/planner.js'
import { runTrials } from '../../core/eval/runner.js'
import { scoreTrials } from '../../core/eval/scorer.js'
import {
  buildRunReport,
  estimateRun,
  validateRunThresholds,
  type RunThresholds,
} from '../../core/run.js'
import { createFileCache, DEFAULT_CACHE_DIR } from '../../runtime/file-cache.js'
import { sanitizeText } from '../../core/report/sanitize.js'
import { loadSurface } from '../../core/surface/fetch.js'
import { parseTaskSet } from '../../core/tasks/load.js'
import { tasksMatchingTags, type Task } from '../../core/tasks/schema.js'
import { validateTaskSet } from '../../core/tasks/validate.js'
import type { Diagnostic } from '../../core/types.js'
import type { Runtime } from '../../runtime/types.js'
import { parseArgs, renderHelp, type FlagSpecs } from '../args.js'
import { loadConfig } from '../config-loader.js'
import { createProviderFromConfig } from '../provider.js'
import { resolveTaskFile, toDisplayPath } from '../paths.js'
import {
  assertRunFormat,
  decideColor,
  FORMAT_EXTENSION,
  renderRun,
  RUN_FORMATS,
} from '../render.js'
import { openTarget } from '../target.js'

export const RUN_FLAGS: FlagSpecs = {
  tasks: { type: 'string', description: 'Task set file (.yaml or .json)', placeholder: 'file' },
  transport: { type: 'string', description: 'snapshot | http | stdio', placeholder: 'name' },
  provider: {
    type: 'string',
    description: 'mock | ollama | openai | openrouter | ...',
    placeholder: 'name',
  },
  model: { type: 'string', description: 'Model id', placeholder: 'id' },
  'base-url': {
    type: 'string',
    description: 'Endpoint for an OpenAI-compatible provider',
    placeholder: 'url',
  },
  repeat: { type: 'number', description: 'Trials per task (default 5)', placeholder: 'n' },
  'max-trials': {
    type: 'number',
    description: `Maximum total trials in a real run (default ${DEFAULT_MAX_TRIALS}; hard max ${ABSOLUTE_MAX_TRIALS})`,
    placeholder: 'n',
  },
  'max-tools': {
    type: 'number',
    description: `Maximum tools shown in a real run (default ${DEFAULT_MAX_TOOLS}; hard max ${ABSOLUTE_MAX_TOOLS})`,
    placeholder: 'n',
  },
  concurrency: { type: 'number', description: 'Trials in flight (default 4)', placeholder: 'n' },
  temperature: {
    type: 'number',
    description: 'Sampling temperature (default 0)',
    placeholder: 'f',
  },
  seed: { type: 'number', description: 'Run seed; trial seeds derive from it', placeholder: 'n' },
  'reasoning-effort': {
    type: 'string',
    description: "Provider reasoning knob, recorded in the run (OpenAI: 'none' for gpt-5.6)",
    placeholder: 'level',
  },
  permute: {
    type: 'boolean',
    description: 'Permute tool order between trials (default on; --no-permute disables)',
  },
  format: { type: 'string', description: RUN_FORMATS.join(' | '), placeholder: 'name' },
  out: { type: 'string', description: 'Write the report to this file', placeholder: 'file' },
  cache: {
    type: 'boolean',
    description: 'Reuse identical trials from disk (default on; --no-cache disables)',
  },
  'cache-dir': {
    type: 'string',
    description: `Cache directory (default ${DEFAULT_CACHE_DIR})`,
    placeholder: 'path',
  },
  'min-accuracy': {
    type: 'number',
    description: 'Exit 1 below this single-call accuracy',
    placeholder: 'f',
  },
  'max-over-trigger': {
    type: 'number',
    description: 'Exit 1 above this over-trigger rate',
    placeholder: 'f',
  },
  'max-context-tokens': {
    type: 'number',
    description: 'Exit 1 above this surface token cost',
    placeholder: 'n',
  },
  'max-error-rate': {
    type: 'number',
    description: 'Exit 2 if more than this share of trials cannot be scored (default 0.1)',
    placeholder: 'f',
  },
  'min-scored': {
    type: 'number',
    description: 'Minimum successfully scored trials for a valid run (default 1)',
    placeholder: 'n',
  },
  only: { type: 'string', description: 'Only tasks carrying this tag', placeholder: 'tag' },
  skip: { type: 'string', description: 'Skip tasks carrying this tag', placeholder: 'tag' },
  'dry-run': {
    type: 'boolean',
    description: 'Count trials and prompt tokens without calling a model',
  },
  'seconds-per-trial': {
    type: 'number',
    description: 'Measured latency, so --dry-run can estimate wall-clock time too',
    placeholder: 'f',
  },
  config: { type: 'string', description: 'Path to a whichtool config file', placeholder: 'file' },
  color: { type: 'boolean', description: 'Force colour on; --no-color forces it off' },
  help: { type: 'boolean', alias: 'h', description: 'Show this help' },
}

const USAGE = `whichtool run <target>

  Put the server's tool surface in front of a model with a set of tasks, and report which
  tool gets picked and which pairs get confused.

  whichtool never executes a tool. It records what the model would have called.
`

export async function runRun(runtime: Runtime, argv: readonly string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, RUN_FLAGS)

  if (flags['help'] === true) {
    runtime.writeOut(renderHelp(USAGE, RUN_FLAGS))
    return 0
  }
  const format = assertRunFormat((flags['format'] as string | undefined) ?? 'terminal')

  const config = await loadConfig(runtime, flags['config'] as string | undefined)
  const transport = await openTarget(runtime, positionals[0], {
    transport: flags['transport'] as string | undefined,
    config,
  })

  try {
    const surface = await loadSurface(transport, {
      provider: flags['provider'] as string | undefined,
    })

    const taskFile = await resolveTaskFile(
      runtime,
      flags['tasks'] as string | undefined,
      config.tasks,
    )
    // The report records the working-directory-relative path, never the absolute one: a
    // committed run must not carry a home directory in it.
    const taskSet = parseTaskSet(
      await runtime.readTextFile(taskFile),
      toDisplayPath(runtime, taskFile),
    )

    const validation = validateTaskSet(taskSet, surface)
    if (!validation.ok) {
      for (const diagnostic of validation.diagnostics) {
        if (diagnostic.severity !== 'error') continue
        runtime.writeErr(
          `whichtool: ${sanitizeText(diagnostic.code)}: ${sanitizeText(diagnostic.message)}\n`,
        )
      }
      throw new WhichtoolError(
        'tasks/invalid',
        'The task set has errors, so the run would measure the wrong thing.',
        'Run `whichtool tasks lint` for the full list.',
      )
    }

    const only = flags['only'] === undefined ? [] : [flags['only'] as string]
    const skip = flags['skip'] === undefined ? [] : [flags['skip'] as string]
    const selected: Task[] = tasksMatchingTags(taskSet.tasks, only, skip)
    if (selected.length === 0) {
      throw new WhichtoolError('tasks/none-selected', 'No task matched the --only/--skip filters.')
    }

    const trialsConfig = config.trials ?? {}
    const plan = planTrials(selected, surface.tools, {
      repeat: (flags['repeat'] as number | undefined) ?? trialsConfig.repeat,
      permute: (flags['permute'] as boolean | undefined) ?? trialsConfig.permute,
      seed: (flags['seed'] as number | undefined) ?? trialsConfig.seed,
    })
    const concurrency =
      (flags['concurrency'] as number | undefined) ?? trialsConfig.concurrency ?? 4
    const maxTrials = assertMaxTrials(
      (flags['max-trials'] as number | undefined) ?? trialsConfig.maxTrials ?? DEFAULT_MAX_TRIALS,
    )
    const maxTools = assertMaxTools(
      (flags['max-tools'] as number | undefined) ?? trialsConfig.maxTools ?? DEFAULT_MAX_TOOLS,
    )
    const thresholds: RunThresholds = {
      minAccuracy: (flags['min-accuracy'] as number | undefined) ?? config.thresholds?.minAccuracy,
      maxOverTrigger:
        (flags['max-over-trigger'] as number | undefined) ?? config.thresholds?.maxOverTrigger,
      maxContextTokens:
        (flags['max-context-tokens'] as number | undefined) ?? config.thresholds?.maxContextTokens,
      maxErrorRate:
        (flags['max-error-rate'] as number | undefined) ?? config.thresholds?.maxErrorRate,
      minScored: (flags['min-scored'] as number | undefined) ?? config.thresholds?.minScored,
    }
    validateRunThresholds(thresholds)
    if (thresholds.minScored !== undefined && thresholds.minScored > plan.trials.length) {
      throw new WhichtoolError(
        'run/impossible-min-scored',
        `minScored is ${thresholds.minScored}, but this run plans only ${plan.trials.length} trials.`,
      )
    }

    const estimate = estimateRun(plan, surface, selected, {
      concurrency,
      secondsPerTrial: flags['seconds-per-trial'] as number | undefined,
    })

    // A dry run is allowed to inspect a plan above either execution limit. It is the safe
    // place to discover that a large task set multiplied by repeat is more work than intended.
    if (flags['dry-run'] === true) {
      const lines = [
        'whichtool run --dry-run',
        `  tasks        ${selected.length} selected of ${taskSet.tasks.length} in ${taskSet.source}`,
        `  trials       ${estimate.trials} = ${selected.length} x ${plan.repeat} repeats`,
        `  prompt floor ~${estimate.promptTokensPerTrial} tokens per trial (surface ${surface.tokens.total} + task text)`,
        `  cold total   ~${estimate.totalPromptTokens} prompt tokens at concurrency ${estimate.concurrency}`,
        `  safety limit ${maxTrials} trials for a real run (hard maximum ${ABSOLUTE_MAX_TRIALS})`,
        estimate.trials <= maxTrials
          ? '  real run     within the configured trial limit'
          : `  real run     BLOCKED until --max-trials is raised to at least ${estimate.trials}`,
        `  tool limit   ${maxTools} tools for a real run (hard maximum ${ABSOLUTE_MAX_TOOLS})`,
        surface.tools.length <= maxTools
          ? '  tool check   within the configured tool limit'
          : `  tool check   BLOCKED until --max-tools is raised to at least ${surface.tools.length}`,
        estimate.estimatedSeconds === null
          ? '  wall clock   unknown: pass --seconds-per-trial with a measured figure to estimate it'
          : `  wall clock   ~${Math.ceil(estimate.estimatedSeconds / 60)} min at ${flags['seconds-per-trial'] as number}s per trial`,
        '',
        '  Prompt tokens are a lower bound, not a price estimate. Output and reasoning tokens',
        '  can be much higher. Built-in provider calls are not retried automatically.',
        '  No model was called.',
        '',
      ]
      runtime.writeOut(lines.join('\n'))
      return 0
    }

    if (surface.tools.length > maxTools) {
      throw new WhichtoolError(
        'run/tool-limit',
        `Surface exposes ${surface.tools.length} tools, above the configured limit of ${maxTools}.`,
        `More tools are not always wrong, but they can increase prompt cost and routing confusion. Review --dry-run and inspect output, then pass --max-tools ${surface.tools.length} if this surface is intentional. The hard maximum is ${ABSOLUTE_MAX_TOOLS}.`,
      )
    }

    if (plan.trials.length > maxTrials) {
      throw new WhichtoolError(
        'run/trial-limit',
        `Run plans ${plan.trials.length} trials, above the configured limit of ${maxTrials}.`,
        `Review it with --dry-run, then pass --max-trials ${plan.trials.length} if acceptable. The hard maximum is ${ABSOLUTE_MAX_TRIALS}.`,
      )
    }
    if (runtime.signal?.aborted === true) throw new CancellationError()

    // the run
    const reasoningEffort =
      (flags['reasoning-effort'] as string | undefined) ?? trialsConfig.reasoningEffort
    const rawProvider = createProviderFromConfig(runtime, {
      config: config.provider,
      name: flags['provider'] as string | undefined,
      model: flags['model'] as string | undefined,
      baseUrl: flags['base-url'] as string | undefined,
      reasoningEffort,
    })

    // Cached by default. The key covers the tool definitions in trial order, so a changed
    // surface misses rather than replaying a stale answer.
    const cacheEnabled = (flags['cache'] as boolean | undefined) ?? true
    const cacheDir = (flags['cache-dir'] as string | undefined) ?? DEFAULT_CACHE_DIR
    const cachingProvider = cacheEnabled
      ? withCache(rawProvider, createFileCache(runtime.resolve(cacheDir), cacheDir))
      : null
    const provider = cachingProvider ?? rawProvider

    const temperature =
      (flags['temperature'] as number | undefined) ?? trialsConfig.temperature ?? 0
    const showProgress = runtime.isStdoutTTY()

    runtime.writeErr(
      `whichtool: running ${estimate.trials} trials against ${sanitizeText(rawProvider.id)}/${sanitizeText(rawProvider.model)}; ` +
        `cold-cache prompt floor ~${estimate.totalPromptTokens} tokens. Output and reasoning are additional.\n`,
    )

    const runnerOptions: Parameters<typeof runTrials>[4] = {
      concurrency,
      maxTools,
      maxTrials,
      signal: runtime.signal,
      temperature,
    }
    if (showProgress) {
      runnerOptions.onTrial = (outcome, completed, total) => {
        const verdict = outcome.error !== undefined ? 'error' : (outcome.pick ?? '(none)')
        runtime.writeErr(
          `  [${completed}/${total}] ${sanitizeText(outcome.taskId)} -> ${sanitizeText(verdict)}\n`,
        )
      }
    }

    const executed = await runTrials(plan, selected, surface.tools, provider, runnerOptions)
    if (executed.cancelled) {
      throw new CancellationError(
        `Run cancelled after ${executed.outcomes.length} of ${plan.trials.length} trials. No report was written.`,
      )
    }
    const scored = scoreTrials(executed.outcomes, surface.tools)

    const cacheDiagnostics: Diagnostic[] = []
    if (cachingProvider !== null && cachingProvider.cacheStats.hits > 0) {
      const { hits, misses } = cachingProvider.cacheStats
      cacheDiagnostics.push({
        code: 'run/cache-hits',
        severity: 'info',
        // The cache directory is deliberately not named here: this message goes into the
        // saved report, and the path may well be absolute.
        message: `${hits} of ${hits + misses} trials were replayed from the cache. They were not sent to the model, so the wall-clock time above is not what this run would cost cold.`,
        detail: { hits, misses },
      })
    }

    const upstream: Diagnostic[] = [
      ...surface.diagnostics,
      ...validation.diagnostics,
      ...cacheDiagnostics,
    ]
    const report = buildRunReport({
      surface,
      taskSet,
      selected,
      plan,
      trials: scored,
      durationMs: executed.durationMs,
      provider: {
        id: provider.id,
        model: provider.model,
        endpoint: provider.endpoint,
        behaviorFingerprint: (await provider.behaviorFingerprint?.()) ?? null,
        capabilities: provider.capabilities,
      },
      temperature,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      concurrency,
      thresholds,
      only,
      skip,
      upstreamDiagnostics: upstream,
    })

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
      // Echo the path the user typed, not the resolved one: this line gets pasted into
      // issues and chat windows, and an absolute path there exposes a home directory.
      await runtime.writeTextFile(runtime.resolve(outPath), rendered)
      runtime.writeErr(`Wrote ${format} report to ${sanitizeText(outPath)}\n`)
    }

    // `report.formats` from the config: write every requested artifact in one pass. This is
    // what an automated flow wants — the JSON to diff against next time, the JUnit for the
    // CI test view, the HTML for a human who opens it when the check goes red.
    const extraFormats = config.report?.formats ?? []
    const reportBase = config.report?.out
    if (extraFormats.length > 0 && reportBase !== undefined) {
      for (const extra of extraFormats) {
        if (extra === 'terminal' && outPath === undefined) continue // already on stdout
        const target = `${reportBase}.${FORMAT_EXTENSION[extra] ?? extra}`
        await runtime.writeTextFile(
          runtime.resolve(target),
          renderRun(report, assertRunFormat(extra), { color: false, width: 88 }),
        )
        runtime.writeErr(`Wrote ${extra} report to ${sanitizeText(target)}\n`)
      }
    }

    if (!report.execution.ok) return 2
    return report.ok ? 0 : 1
  } finally {
    await transport.close?.()
  }
}
