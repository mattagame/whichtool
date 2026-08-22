import { extname, isAbsolute, relative, sep } from 'node:path'
import type { WhichtoolConfig } from '../../config.js'
import { withCache } from '../../core/cache/provider.js'
import { diffRuns, parseRunReport, type RunDiff } from '../../core/diff.js'
import { WhichtoolError } from '../../core/errors.js'
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
import { buildInspectReport, type InspectReport } from '../../core/inspect.js'
import { isJsonObject } from '../../core/json.js'
import {
  MCP_MAX_CONCURRENCY,
  MCP_MAX_REPEAT,
  MCP_MAX_TOOLS,
  MCP_MAX_TRIALS,
  MCP_SERVER_TOOLS,
} from '../../core/mcp-server/tools.js'
import { buildRunReport, estimateRun, type RunReport } from '../../core/run.js'
import { loadSurface } from '../../core/surface/fetch.js'
import { parseTaskSet } from '../../core/tasks/load.js'
import { validateTaskSet, type TaskSetValidation } from '../../core/tasks/validate.js'
import {
  MCP_PROTOCOL_VERSION,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
} from '../../core/transport/mcp.js'
import type { Diagnostic, JsonObject, JsonValue, Surface } from '../../core/types.js'
import { createFileCache, DEFAULT_CACHE_DIR } from '../../runtime/file-cache.js'
import type { Runtime } from '../../runtime/types.js'
import { WHICHTOOL_VERSION } from '../../version.js'
import { parseArgs, renderHelp, type FlagSpecs } from '../args.js'
import { loadConfig } from '../config-loader.js'
import { redactMachinePaths, toDisplayPath } from '../paths.js'
import { createProviderFromConfig } from '../provider.js'
import { openTarget } from '../target.js'

export const MCP_FLAGS: FlagSpecs = {
  cache: {
    type: 'boolean',
    description:
      'Persist prompts and provider responses for reuse (privacy-sensitive; default off)',
  },
  'cache-dir': {
    type: 'string',
    description: `Trial cache directory (default ${DEFAULT_CACHE_DIR})`,
    placeholder: 'path',
  },
  config: {
    type: 'string',
    description: 'Path to an explicit data-only whichtool JSON config',
    placeholder: 'file.json',
  },
  'allow-dynamic-targets': {
    type: 'boolean',
    description: 'Unsafe opt-in: accept target paths, URLs or stdio commands from tool calls',
  },
  'allow-paid-runs': {
    type: 'boolean',
    description: 'Opt in to real provider calls; otherwise run_evaluation is dry-run only',
  },
  'max-trials': {
    type: 'number',
    description: `Operator limit for one real evaluation (default ${DEFAULT_MAX_TRIALS}; hard max ${ABSOLUTE_MAX_TRIALS})`,
    placeholder: 'n',
  },
  'max-tools': {
    type: 'number',
    description: `Operator limit for tools shown in one real evaluation (default ${DEFAULT_MAX_TOOLS}; hard max ${ABSOLUTE_MAX_TOOLS})`,
    placeholder: 'n',
  },
  'allow-provider-overrides': {
    type: 'boolean',
    description: 'Unsafe opt-in: let tool calls replace the configured provider or model',
  },
  'result-file': {
    type: 'string',
    description: 'Operator-selected JSON file for the full latest run report',
    placeholder: 'file',
  },
  help: { type: 'boolean', alias: 'h', description: 'Show this help' },
}

const USAGE = `whichtool mcp

  Run whichtool as an MCP server on stdio, so an agent can evaluate a tool surface itself.

  Safe default (the operator selects target, tasks and provider):

    { "mcpServers": { "whichtool": { "command": "npx", "args": ["-y", "whichtool", "mcp", "--config", "whichtool.config.json"] } } }

  It exposes four tools: inspect_surface, run_evaluation, validate_task_file and
  diff_saved_results. Dynamic targets and real provider calls are separate startup opt-ins.
  Results use a versioned JSON envelope; large per-trial reports stay out of model context.
`

const SERVER_INFO = { name: 'whichtool', version: WHICHTOOL_VERSION }
const SERVER_META: JsonObject = { [META_SERVER_INFO]: SERVER_INFO }
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const
const LATEST_LEGACY_VERSION = LEGACY_VERSIONS[0]
const RESULT_SCHEMA_VERSION = 'whichtool.mcp-result/1'
// Includes surface inspections that may start a configured subprocess. Keep the default
// deliberately small so request fan-out cannot become process fan-out.
const MCP_MAX_IN_FLIGHT = 4
const MCP_MAX_DIAGNOSTICS = 50
const MCP_MAX_METRIC_ITEMS = 20
const MCP_MAX_TEXT_CHARS = 4_000
const MCP_MAX_STRUCTURED_RESULT_CHARS = 256 * 1024
export const MCP_MAX_INBOUND_LINE_CHARS = 1024 * 1024
export const MCP_MAX_AGENT_FILE_BYTES = 16 * 1024 * 1024

/** Thrown when a cancelled request must produce no further protocol message. */
class CancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CancelledError'
  }
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: JsonObject
  isError?: boolean
}

function boundedText(value: string): string {
  if (value.length <= MCP_MAX_TEXT_CHARS) return value
  return `${value.slice(0, MCP_MAX_TEXT_CHARS)}… [truncated]`
}

interface McpPolicy {
  config: WhichtoolConfig
  maxTrials: number
  maxTools: number
  cacheEnabled: boolean
  allowDynamicTargets: boolean
  allowPaidRuns: boolean
  allowProviderOverrides: boolean
  resultFile?: string | undefined
  paidRunActive: boolean
}

function successful(payload: JsonValue, summary: string): ToolResult {
  const semanticOk =
    isJsonObject(payload) && typeof payload['ok'] === 'boolean' ? payload['ok'] : true
  const verdictSummary = boundedText(
    semanticOk ? summary : `Completed with a failing verdict. ${summary}`,
  )
  const envelope: JsonObject = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: semanticOk,
    summary: verdictSummary,
    data: payload,
  }
  if (JSON.stringify(envelope).length > MCP_MAX_STRUCTURED_RESULT_CHARS) {
    return failed(
      'mcp/result-too-large',
      `The bounded MCP result still exceeds ${MCP_MAX_STRUCTURED_RESULT_CHARS} characters.`,
      'Use the CLI for the complete artifact, or reduce the selected surface/task set. For evaluations, start the server with --result-file and read the operator-selected artifact outside model context.',
    )
  }
  return {
    // Do not duplicate structured data into the model's text context. Older clients still
    // get the human-readable summary; modern clients receive the complete typed envelope.
    content: [{ type: 'text', text: verdictSummary }],
    structuredContent: envelope,
  }
}

function failed(code: string, message: string, hint?: string, detail?: JsonValue): ToolResult {
  const safeMessage = boundedText(message)
  const safeHint = hint === undefined ? undefined : boundedText(hint)
  const error: JsonObject = { code: boundedText(code), message: safeMessage }
  if (safeHint !== undefined) error['hint'] = safeHint
  if (detail !== undefined) error['detail'] = detail
  const envelope: JsonObject = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    ok: false,
    summary: safeMessage,
    error,
  }
  if (JSON.stringify(envelope).length > MCP_MAX_STRUCTURED_RESULT_CHARS) {
    delete error['detail']
    error['detail'] = { omitted: true, reason: 'detail exceeded the MCP result size limit' }
  }
  return {
    content: [{ type: 'text', text: boundedText(`[${code}] ${safeMessage}`) }],
    structuredContent: envelope,
    isError: true,
  }
}

function stringArg(args: JsonObject, name: string): string | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WhichtoolError('mcp/invalid-argument', `\`${name}\` must be a non-empty string.`)
  }
  return value
}

function numberArg(args: JsonObject, name: string): number | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WhichtoolError('mcp/invalid-argument', `\`${name}\` must be a finite number.`)
  }
  return value
}

function booleanArg(args: JsonObject, name: string): boolean | undefined {
  const value = args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new WhichtoolError('mcp/invalid-argument', `\`${name}\` must be a boolean.`)
  }
  return value
}

function integerInRange(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WhichtoolError(
      'mcp/limit-exceeded',
      `\`${name}\` must be an integer from ${minimum} to ${maximum}; got ${value}.`,
    )
  }
  return value
}

function fractionArg(args: JsonObject, name: string): number | undefined {
  const value = numberArg(args, name)
  if (value === undefined) return undefined
  if (value < 0 || value > 1) {
    throw new WhichtoolError(
      'mcp/invalid-argument',
      `\`${name}\` must be a number from 0 to 1; got ${value}.`,
    )
  }
  return value
}

function assertWorkspacePath(root: string, absolute: string, label: string): void {
  const fromRoot = relative(root, absolute)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new WhichtoolError(
      'mcp/path-outside-workspace',
      `\`${label}\` must stay inside the MCP server working directory.`,
      'Move the artifact into the workspace, or select it in the operator-owned startup config.',
    )
  }
}

async function workspaceFile(runtime: Runtime, path: string, label: string): Promise<string> {
  // Reject an explicit lexical escape before touching the path, then repeat the check on
  // its canonical target so an in-workspace symlink or Windows junction cannot cross the
  // boundary. Later reads use that canonical target rather than the supplied link.
  const requestedRoot = runtime.resolve('.')
  const requested = runtime.resolve(path)
  assertWorkspacePath(requestedRoot, requested, label)
  const [root, absolute] = await Promise.all([
    runtime.realpath(requestedRoot),
    runtime.realpath(requested),
  ])
  assertWorkspacePath(root, absolute, label)
  const size = await runtime.fileSize(absolute)
  if (size > MCP_MAX_AGENT_FILE_BYTES) {
    throw new WhichtoolError(
      'mcp/file-too-large',
      `\`${label}\` is ${size} bytes; agent-selected files may be at most ${MCP_MAX_AGENT_FILE_BYTES} bytes.`,
      'Use a smaller prepared artifact, or select a trusted input in the operator-owned startup config.',
    )
  }
  return absolute
}

async function tasksFile(
  runtime: Runtime,
  args: JsonObject,
  config: WhichtoolConfig,
): Promise<string> {
  const supplied = stringArg(args, 'tasks')
  if (supplied !== undefined) return workspaceFile(runtime, supplied, 'tasks')
  if (config.tasks !== undefined) return runtime.resolve(config.tasks)
  throw new WhichtoolError(
    'tasks/missing',
    'No task file given and no `tasks` path exists in the startup config.',
  )
}

function hasDynamicTarget(args: JsonObject): boolean {
  return args['target'] !== undefined || args['transport'] !== undefined
}

async function openSurface(
  runtime: Runtime,
  args: JsonObject,
  policy: McpPolicy,
): Promise<{ surface: Surface; close: () => Promise<void> }> {
  const dynamic = hasDynamicTarget(args)
  if (dynamic && !policy.allowDynamicTargets) {
    throw new WhichtoolError(
      'mcp/dynamic-target-disabled',
      'This MCP server accepts only the target selected in its startup config.',
      'The operator can restart it with `--allow-dynamic-targets`, which permits agent-supplied paths, URLs and subprocess commands.',
    )
  }

  const requestedTarget = stringArg(args, 'target')
  const requestedTransport = stringArg(args, 'transport')
  const target =
    dynamic &&
    requestedTarget !== undefined &&
    (requestedTransport === 'snapshot' ||
      (requestedTransport === undefined && /\.json$/i.test(requestedTarget)))
      ? await workspaceFile(runtime, requestedTarget, 'target')
      : requestedTarget

  const transport = await openTarget(runtime, target, {
    transport: requestedTransport,
    config: policy.config,
    // A credential from the host environment must never be attached to a URL supplied by
    // a model, even when the operator enabled dynamic target access.
    allowEnvAuthorization: !dynamic,
  })
  try {
    const surface = await loadSurface(transport)
    return {
      surface,
      close: async () => {
        await transport.close?.()
      },
    }
  } catch (cause) {
    await transport.close?.().catch((closeCause: unknown) => {
      const message = redactMachinePaths(
        closeCause instanceof Error ? closeCause.message : String(closeCause),
        runtime.cwd(),
      )
      runtime.writeErr(`whichtool mcp: failed to close target after load error: ${message}\n`)
    })
    throw cause
  }
}

function compactDiagnostic(diagnostic: Diagnostic): JsonObject {
  const tools = diagnostic.tools?.slice(0, MCP_MAX_METRIC_ITEMS).map(boundedText)
  return {
    code: boundedText(diagnostic.code),
    severity: diagnostic.severity,
    message: boundedText(diagnostic.message),
    ...(diagnostic.tool === undefined ? {} : { tool: boundedText(diagnostic.tool) }),
    ...(tools === undefined
      ? {}
      : {
          tools,
          omittedTools: Math.max(0, (diagnostic.tools?.length ?? 0) - tools.length),
        }),
  }
}

function diagnosticsSummary(diagnostics: readonly Diagnostic[]): {
  counts: JsonObject
  items: JsonValue
  omitted: number
} {
  const counts: JsonObject = { error: 0, warning: 0, info: 0, total: diagnostics.length }
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity in counts) {
      counts[diagnostic.severity] = Number(counts[diagnostic.severity] ?? 0) + 1
    }
  }
  return {
    counts,
    items: diagnostics.slice(0, MCP_MAX_DIAGNOSTICS).map(compactDiagnostic),
    omitted: Math.max(0, diagnostics.length - MCP_MAX_DIAGNOSTICS),
  }
}

function compactInspectReport(report: InspectReport): JsonObject {
  const diagnostics = diagnosticsSummary(report.diagnostics)
  return {
    schemaVersion: 'whichtool.mcp-inspect-summary/1',
    reportSchemaVersion: report.schemaVersion,
    ok: report.ok,
    analysisOk: report.analysisOk,
    thresholdsOk: report.thresholdsOk,
    target: report.target as unknown as JsonValue,
    surface: { hash: report.surface.hash, toolCount: report.surface.toolCount },
    tokens: {
      total: report.tokens.total,
      tokenizer: report.tokens.tokenizer as unknown as JsonValue,
      serialization: report.tokens.serialization,
    },
    annotations: report.annotations as unknown as JsonValue,
    overlap: {
      method: report.overlap.method,
      pairsConsidered: report.overlap.pairsConsidered,
      pairsReported: report.overlap.pairsReported,
      pairs: report.overlap.pairs.slice(0, MCP_MAX_METRIC_ITEMS) as unknown as JsonValue,
      omitted: Math.max(0, report.overlap.pairs.length - MCP_MAX_METRIC_ITEMS),
    },
    headerParams: report.headerParams as unknown as JsonValue,
    diagnostics: diagnostics as unknown as JsonValue,
    thresholds: report.thresholds as unknown as JsonValue,
    omitted: { toolSummaries: report.surface.tools.length },
  }
}

function compactRunReport(report: RunReport, artifact?: JsonObject): JsonObject {
  const diagnostics = diagnosticsSummary(report.diagnostics)
  const metrics = report.metrics
  return {
    schemaVersion: 'whichtool.mcp-run-summary/1',
    reportSchemaVersion: report.schemaVersion,
    ok: report.ok,
    target: report.target as unknown as JsonValue,
    reproducibility: report.reproducibility as unknown as JsonValue,
    tasks: {
      inFile: report.tasks.inFile,
      selected: report.tasks.selected,
      distractors: report.tasks.distractors,
    },
    metrics: {
      trials: metrics.trials as unknown as JsonValue,
      accuracy: metrics.accuracy as unknown as JsonValue,
      abstention: metrics.abstention as unknown as JsonValue,
      overTrigger: metrics.overTrigger as unknown as JsonValue,
      phantom: metrics.phantom as unknown as JsonValue,
      clarification: metrics.clarification as unknown as JsonValue,
      multiCallRate: metrics.multiCallRate as unknown as JsonValue,
      byTool: metrics.byTool.slice(0, MCP_MAX_METRIC_ITEMS) as unknown as JsonValue,
      confusionPairs: metrics.confusionPairs.slice(0, MCP_MAX_METRIC_ITEMS) as unknown as JsonValue,
      position: metrics.position as unknown as JsonValue,
      minTrialsPerTool: metrics.minTrialsPerTool,
      omitted: {
        byTool: Math.max(0, metrics.byTool.length - MCP_MAX_METRIC_ITEMS),
        confusionPairs: Math.max(0, metrics.confusionPairs.length - MCP_MAX_METRIC_ITEMS),
        confusionMatrix: true,
      },
    },
    contextCost: {
      total: report.contextCost.total,
      tokenizer: report.contextCost.tokenizer as unknown as JsonValue,
    },
    diagnostics: diagnostics as unknown as JsonValue,
    thresholds: report.thresholds as unknown as JsonValue,
    thresholdsOk: report.thresholdsOk,
    execution: report.execution as unknown as JsonValue,
    durationMs: report.durationMs,
    trialCount: report.trials.length,
    ...(artifact === undefined ? {} : { artifact }),
  }
}

function compactTaskValidation(validation: TaskSetValidation, surfaceChecked: boolean): JsonObject {
  const diagnostics = diagnosticsSummary(validation.diagnostics)
  const uncoveredTools = validation.coverage.uncoveredTools.slice(0, MCP_MAX_METRIC_ITEMS)
  return {
    schemaVersion: 'whichtool.mcp-task-validation-summary/1',
    ok: validation.ok,
    surfaceChecked,
    coverage: {
      taskCount: validation.coverage.taskCount,
      distractorCount: validation.coverage.distractorCount,
      toolsOnSurface: validation.coverage.toolsOnSurface,
      toolsCovered: validation.coverage.toolsCovered,
      uncoveredTools,
      omittedUncoveredTools: Math.max(
        0,
        validation.coverage.uncoveredTools.length - uncoveredTools.length,
      ),
    },
    diagnostics: diagnostics as unknown as JsonValue,
  }
}

function compactRunDiff(diff: RunDiff): JsonObject {
  const diagnostics = diagnosticsSummary(diff.diagnostics)
  const incomparable = diff.incomparable.slice(0, MCP_MAX_DIAGNOSTICS)
  return {
    schemaVersion: 'whichtool.mcp-diff-summary/1',
    reportSchemaVersion: diff.schemaVersion,
    ok: diff.ok,
    comparable: diff.comparable,
    base: diff.base as unknown as JsonValue,
    head: diff.head as unknown as JsonValue,
    incomparable,
    accuracy: diff.accuracy as unknown as JsonValue,
    overTrigger: diff.overTrigger as unknown as JsonValue,
    multiCall: diff.multiCall as unknown as JsonValue,
    contextTokens: diff.contextTokens as unknown as JsonValue,
    byTool: diff.byTool.slice(0, MCP_MAX_METRIC_ITEMS) as unknown as JsonValue,
    newConfusions: diff.newConfusions.slice(0, MCP_MAX_METRIC_ITEMS) as unknown as JsonValue,
    resolvedConfusions: diff.resolvedConfusions.slice(
      0,
      MCP_MAX_METRIC_ITEMS,
    ) as unknown as JsonValue,
    diagnostics: diagnostics as unknown as JsonValue,
    omitted: {
      incomparable: Math.max(0, diff.incomparable.length - incomparable.length),
      byTool: Math.max(0, diff.byTool.length - MCP_MAX_METRIC_ITEMS),
      newConfusions: Math.max(0, diff.newConfusions.length - MCP_MAX_METRIC_ITEMS),
      resolvedConfusions: Math.max(0, diff.resolvedConfusions.length - MCP_MAX_METRIC_ITEMS),
    },
  }
}

async function callTool(
  runtime: Runtime,
  name: string,
  args: JsonObject,
  cacheDir: string,
  signal: AbortSignal,
  policy: McpPolicy,
): Promise<ToolResult> {
  switch (name) {
    case 'inspect_surface': {
      const { surface, close } = await openSurface(runtime, args, policy)
      try {
        const rawMaxContextTokens = numberArg(args, 'maxContextTokens')
        const maxContextTokens =
          rawMaxContextTokens === undefined
            ? undefined
            : integerInRange('maxContextTokens', rawMaxContextTokens, 0, Number.MAX_SAFE_INTEGER)
        const report = buildInspectReport(
          surface,
          maxContextTokens === undefined ? {} : { maxContextTokens },
        )
        const errors = report.diagnostics.filter(
          (diagnostic) => diagnostic.severity === 'error',
        ).length
        const warnings = report.diagnostics.filter(
          (diagnostic) => diagnostic.severity === 'warning',
        ).length
        return successful(
          compactInspectReport(report),
          `${report.surface.toolCount} tool${report.surface.toolCount === 1 ? '' : 's'}, ~${report.tokens.total} tokens (estimate), ${errors} error${errors === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'}. No tool was executed.`,
        )
      } finally {
        await close()
      }
    }

    case 'validate_task_file': {
      const absolute = await tasksFile(runtime, args, policy.config)
      let surface: Surface | null = null
      let close: (() => Promise<void>) | null = null
      if (policy.config.target !== undefined || hasDynamicTarget(args)) {
        const opened = await openSurface(runtime, args, policy)
        surface = opened.surface
        close = opened.close
      }
      try {
        const taskSet = parseTaskSet(
          await runtime.readTextFile(absolute),
          toDisplayPath(runtime, absolute),
        )
        const validation = validateTaskSet(taskSet, surface)
        return successful(
          compactTaskValidation(validation, surface !== null),
          validation.ok
            ? `${validation.coverage.taskCount} tasks, ${validation.coverage.distractorCount} distractors, no errors.`
            : `${validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length} errors: the evaluation would measure the wrong thing.`,
        )
      } finally {
        await close?.()
      }
    }

    case 'diff_saved_results': {
      const basePath = stringArg(args, 'base')
      const headPath = stringArg(args, 'head')
      if (basePath === undefined || headPath === undefined) {
        return failed('mcp/missing-argument', '`base` and `head` are both required.')
      }
      const read = async (path: string, label: string) => {
        const absolute = await workspaceFile(runtime, path, label)
        return parseRunReport(
          JSON.parse(await runtime.readTextFile(absolute)),
          toDisplayPath(runtime, absolute),
        )
      }

      const maxAccuracyDrop = fractionArg(args, 'maxAccuracyDrop')
      const diff = diffRuns(
        await read(basePath, 'base'),
        await read(headPath, 'head'),
        maxAccuracyDrop === undefined ? {} : { maxAccuracyDrop },
      )
      return successful(
        compactRunDiff(diff),
        diff.comparable
          ? `${diff.ok ? 'No regression' : 'Regression'}. Accuracy delta ${diff.accuracy.delta === null ? 'n/a' : Math.round(diff.accuracy.delta * 100)} points; paired evidence ${diff.accuracy.distinguishable ? `is distinguishable (p=${diff.accuracy.paired.pValue.toFixed(4)})` : `is inconclusive (p=${diff.accuracy.paired.pValue.toFixed(4)})`}.`
          : `Not comparable: ${diff.incomparable.join('; ')}`,
      )
    }

    case 'run_evaluation': {
      const requestedProvider = stringArg(args, 'provider')
      const requestedModel = stringArg(args, 'model')
      if (
        (requestedProvider !== undefined || requestedModel !== undefined) &&
        !policy.allowProviderOverrides
      ) {
        return failed(
          'mcp/provider-override-disabled',
          'This MCP server accepts only the provider and model selected in its startup config.',
          'The operator can restart it with `--allow-provider-overrides` after reviewing which external services the agent may select.',
        )
      }
      const absolute = await tasksFile(runtime, args, policy.config)
      const { surface, close } = await openSurface(runtime, args, policy)
      try {
        const taskSet = parseTaskSet(
          await runtime.readTextFile(absolute),
          toDisplayPath(runtime, absolute),
        )
        const validation = validateTaskSet(taskSet, surface)
        if (!validation.ok) {
          const errors = validation.diagnostics.filter(
            (diagnostic) => diagnostic.severity === 'error',
          )
          return failed(
            'tasks/invalid',
            'The task set has errors, so the evaluation would measure the wrong thing.',
            errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('\n'),
            { diagnostics: errors as unknown as JsonValue },
          )
        }

        const rawRepeat = numberArg(args, 'repeat') ?? policy.config.trials?.repeat ?? 5
        const repeat = integerInRange('repeat', rawRepeat, 1, MCP_MAX_REPEAT)
        const plannedTrials = taskSet.tasks.length * repeat
        const rawConcurrency =
          numberArg(args, 'concurrency') ?? policy.config.trials?.concurrency ?? 4
        const concurrency = integerInRange('concurrency', rawConcurrency, 1, MCP_MAX_CONCURRENCY)
        const minAccuracy = fractionArg(args, 'minAccuracy')
        const maxOverTrigger = fractionArg(args, 'maxOverTrigger')
        const plan = planTrials(taskSet.tasks, surface.tools, {
          repeat,
          permute: policy.config.trials?.permute,
          seed: policy.config.trials?.seed,
        })
        const estimate = estimateRun(plan, surface, taskSet.tasks, { concurrency })
        const planSummary: JsonObject = {
          ...(estimate as unknown as JsonObject),
          tools: surface.tools.length,
          promptTokenEstimate: 'lower-bound',
          maxTrials: policy.maxTrials,
          hardMaxTrials: MCP_MAX_TRIALS,
          withinTrialLimit: plannedTrials <= policy.maxTrials,
          maxTools: policy.maxTools,
          hardMaxTools: MCP_MAX_TOOLS,
          withinToolLimit: surface.tools.length <= policy.maxTools,
          provider: {
            name: requestedProvider ?? policy.config.provider?.name ?? null,
            model: requestedModel ?? policy.config.provider?.model ?? null,
            reasoningEffort: policy.config.trials?.reasoningEffort ?? null,
          },
        }

        if (booleanArg(args, 'dryRun') === true) {
          return successful(
            planSummary,
            `${estimate.trials} trials across ${surface.tools.length} tools would be run. The prompt-token lower bound is about ${estimate.totalPromptTokens}; output and reasoning tokens are additional. ${plannedTrials <= policy.maxTrials && surface.tools.length <= policy.maxTools ? 'A real run is within the operator limits.' : 'A real run is blocked by an operator limit.'} No model was called.`,
          )
        }

        if (surface.tools.length > MCP_MAX_TOOLS) {
          return failed(
            'mcp/limit-exceeded',
            `The surface contains ${surface.tools.length} tools; the hard limit is ${MCP_MAX_TOOLS}.`,
            'Reduce or split the surface. The hard limit cannot be overridden.',
            { plan: planSummary },
          )
        }

        if (surface.tools.length > policy.maxTools) {
          return failed(
            'mcp/tool-limit',
            `The surface contains ${surface.tools.length} tools; the operator limit is ${policy.maxTools}.`,
            `Review inspect_surface and a dry run, then have the operator restart whichtool with --max-tools ${surface.tools.length} if the surface is intentional.`,
            { plan: planSummary },
          )
        }

        if (plannedTrials > MCP_MAX_TRIALS) {
          return failed(
            'mcp/limit-exceeded',
            `The plan contains ${plannedTrials} trials; the hard limit is ${MCP_MAX_TRIALS}.`,
            'Reduce the task set or repeat count. The hard limit cannot be overridden.',
            { plan: planSummary },
          )
        }

        if (plannedTrials > policy.maxTrials) {
          return failed(
            'mcp/trial-limit',
            `The plan contains ${plannedTrials} trials; the operator limit is ${policy.maxTrials}.`,
            `Review a dry run, then have the operator restart whichtool with --max-trials ${plannedTrials} if acceptable. The hard maximum is ${MCP_MAX_TRIALS}.`,
            { plan: planSummary },
          )
        }

        if (!policy.allowPaidRuns) {
          return failed(
            'mcp/paid-run-disabled',
            'Real provider calls are disabled for this MCP server.',
            'Review the attached plan, then have the operator restart whichtool with `--allow-paid-runs` if the cost and data destination are acceptable.',
            { plan: planSummary },
          )
        }

        if (policy.paidRunActive) {
          return failed(
            'mcp/run-busy',
            'Another paid evaluation is already running in this MCP server process.',
            'Wait for it to finish or cancel it before starting another paid run.',
            { plan: planSummary },
          )
        }

        policy.paidRunActive = true
        try {
          const rawProvider = createProviderFromConfig(runtime, {
            config: policy.config.provider,
            name: requestedProvider,
            model: requestedModel,
            reasoningEffort: policy.config.trials?.reasoningEffort,
          })
          const cachingProvider = policy.cacheEnabled
            ? withCache(rawProvider, createFileCache(runtime.resolve(cacheDir), cacheDir))
            : null
          const provider = cachingProvider ?? rawProvider

          runtime.writeErr(
            `whichtool: running ${plan.trials.length} trials against ${provider.model}; ` +
              `cold-cache prompt floor ~${estimate.totalPromptTokens} tokens. Output and reasoning are additional.\n`,
          )
          const executed = await runTrials(plan, taskSet.tasks, surface.tools, provider, {
            concurrency,
            maxTools: policy.maxTools,
            maxTrials: policy.maxTrials,
            temperature: policy.config.trials?.temperature ?? 0,
            signal,
          })
          if (executed.cancelled) {
            throw new CancelledError(
              `cancelled after ${executed.outcomes.length} of ${plan.trials.length} trials`,
            )
          }

          const inspectDiagnostics = buildInspectReport(
            surface,
            policy.config.thresholds?.maxContextTokens === undefined
              ? {}
              : { maxContextTokens: policy.config.thresholds.maxContextTokens },
          ).diagnostics
          const cacheDiagnostics: Diagnostic[] = []
          if (cachingProvider !== null && cachingProvider.cacheStats.hits > 0) {
            const { hits, misses } = cachingProvider.cacheStats
            cacheDiagnostics.push({
              code: 'run/cache-hits',
              severity: 'info',
              message: `${hits} of ${hits + misses} trials were replayed from the cache. They were not sent to the model, so this run does not represent a cold execution.`,
              detail: { hits, misses },
            })
          }
          const report = buildRunReport({
            surface,
            taskSet,
            selected: taskSet.tasks,
            plan,
            trials: scoreTrials(executed.outcomes, surface.tools),
            durationMs: executed.durationMs,
            provider: {
              id: provider.id,
              model: provider.model,
              endpoint: provider.endpoint,
              behaviorFingerprint: (await provider.behaviorFingerprint?.()) ?? null,
              capabilities: provider.capabilities,
            },
            temperature: policy.config.trials?.temperature ?? 0,
            reasoningEffort: policy.config.trials?.reasoningEffort,
            concurrency,
            thresholds: {
              minAccuracy: minAccuracy ?? policy.config.thresholds?.minAccuracy,
              maxOverTrigger: maxOverTrigger ?? policy.config.thresholds?.maxOverTrigger,
              maxContextTokens: policy.config.thresholds?.maxContextTokens,
              maxErrorRate: policy.config.thresholds?.maxErrorRate,
              minScored: policy.config.thresholds?.minScored,
            },
            upstreamDiagnostics: [
              ...inspectDiagnostics,
              ...validation.diagnostics,
              ...cacheDiagnostics,
            ],
          })

          let artifact: JsonObject | undefined
          if (policy.resultFile !== undefined) {
            const output = `${JSON.stringify(report, null, 2)}\n`
            const absoluteResult = runtime.resolve(policy.resultFile)
            await runtime.writeTextFile(absoluteResult, output)
            artifact = {
              kind: 'file',
              path: toDisplayPath(runtime, absoluteResult),
              mediaType: 'application/json',
              schemaVersion: report.schemaVersion,
              characters: output.length,
            }
          }

          const accuracy = report.metrics.accuracy
          return successful(
            compactRunReport(report, artifact),
            `single-call accuracy ${accuracy.numerator}/${accuracy.denominator}${accuracy.ci95 === null ? '' : ` (95% CI ${Math.round(accuracy.ci95[0] * 100)}-${Math.round(accuracy.ci95[1] * 100)}%)`}, ` +
              `${report.metrics.confusionPairs.length} confused pairs, ${report.metrics.trials.errored} trials failed at the provider. No tool was executed.`,
          )
        } finally {
          policy.paidRunActive = false
        }
      } finally {
        await close()
      }
    }

    default:
      return failed(
        'mcp/unknown-tool',
        `Unknown tool \`${name}\`.`,
        `Available: ${MCP_SERVER_TOOLS.map((tool) => tool.name).join(', ')}.`,
      )
  }
}

interface Reply {
  jsonrpc: '2.0'
  id: JsonValue
  result?: JsonValue
  error?: { code: number; message: string; data?: JsonValue }
}

type ProtocolEra = 'unknown' | 'modern' | 'legacy'

function isModernEra(era: ProtocolEra): boolean {
  return era === 'modern'
}

function modernResult(payload: JsonObject): JsonObject {
  const existingMeta = isJsonObject(payload['_meta']) ? payload['_meta'] : {}
  return {
    ...payload,
    resultType: 'complete',
    _meta: { ...existingMeta, ...SERVER_META },
  }
}

function requestDeclaresModern(params: JsonObject): boolean {
  const meta = params['_meta']
  return isJsonObject(meta) && meta[META_PROTOCOL_VERSION] === MCP_PROTOCOL_VERSION
}

export async function runMcpServer(runtime: Runtime, argv: readonly string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, MCP_FLAGS)
  if (positionals.length > 0) {
    throw new WhichtoolError('cli/bad-arguments', `Unexpected argument \`${positionals[0]}\`.`)
  }
  if (flags['help'] === true) {
    runtime.writeOut(renderHelp(USAGE, MCP_FLAGS))
    return 0
  }

  const configPath = flags['config'] as string | undefined
  if (configPath !== undefined && extname(configPath).toLowerCase() !== '.json') {
    throw new WhichtoolError(
      'mcp/unsafe-config-format',
      '`whichtool mcp --config` accepts JSON only.',
      'Executable JavaScript and TypeScript config files are supported by the human CLI, but an agent-facing server must start from an explicit, data-only JSON config.',
    )
  }
  // Never auto-discover executable config from an untrusted working directory. The MCP
  // process receives authority only from an explicit, data-only startup file.
  const config = configPath === undefined ? {} : await loadConfig(runtime, configPath)
  const policy: McpPolicy = {
    config,
    maxTools: assertMaxTools(
      (flags['max-tools'] as number | undefined) ?? config.trials?.maxTools ?? DEFAULT_MAX_TOOLS,
    ),
    maxTrials: assertMaxTrials(
      (flags['max-trials'] as number | undefined) ?? config.trials?.maxTrials ?? DEFAULT_MAX_TRIALS,
    ),
    cacheEnabled: flags['cache'] === true,
    allowDynamicTargets: flags['allow-dynamic-targets'] === true,
    allowPaidRuns: flags['allow-paid-runs'] === true,
    allowProviderOverrides: flags['allow-provider-overrides'] === true,
    resultFile: flags['result-file'] as string | undefined,
    paidRunActive: false,
  }
  const cacheDir = (flags['cache-dir'] as string | undefined) ?? DEFAULT_CACHE_DIR

  const send = (reply: Reply): void => {
    runtime.writeOut(`${JSON.stringify(reply)}\n`)
  }

  const inFlight = new Map<string, AbortController>()
  let era: ProtocolEra = 'unknown'

  const protocolError = (id: JsonValue, code: number, message: string, modern: boolean): Reply => ({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(modern ? { data: { _meta: SERVER_META } } : {}),
    },
  })

  const handle = async (message: JsonObject): Promise<Reply | null> => {
    const id = (message['id'] ?? null) as JsonValue
    const method = message['method']
    const params = isJsonObject(message['params']) ? message['params'] : {}

    if (method === 'server/discover' || requestDeclaresModern(params)) era = 'modern'
    const modern = era === 'modern'

    if (typeof method !== 'string') return protocolError(id, -32600, 'not a request', modern)

    if (message['id'] === undefined) {
      if (method === 'notifications/cancelled') {
        const target = params['requestId']
        const controller = target === undefined ? undefined : inFlight.get(String(target))
        if (controller !== undefined) {
          controller.abort()
          runtime.writeErr(`whichtool mcp: cancelling request ${String(target)}\n`)
        }
      }
      return null
    }

    switch (method) {
      case 'server/discover':
        return {
          jsonrpc: '2.0',
          id,
          result: modernResult({
            supportedVersions: [MCP_PROTOCOL_VERSION],
            capabilities: { tools: { listChanged: false } },
            instructions:
              'Use inspect_surface first. run_evaluation is dry-run only unless the server operator enabled real provider calls; target overrides are disabled unless separately enabled.',
            ttlMs: 3_600_000,
            cacheScope: 'private',
          }),
        }

      case 'initialize': {
        era = 'legacy'
        const requested = params['protocolVersion']
        const version =
          typeof requested === 'string' &&
          (LEGACY_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : LATEST_LEGACY_VERSION
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        }
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: modern ? modernResult({}) : {} }

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: modern
            ? modernResult({
                tools: MCP_SERVER_TOOLS as unknown as JsonValue,
                ttlMs: 3_600_000,
                cacheScope: 'private',
              })
            : { tools: MCP_SERVER_TOOLS as unknown as JsonValue },
        }

      case 'tools/call': {
        const name = params['name']
        if (typeof name !== 'string') {
          return protocolError(id, -32602, 'params.name is required', modern)
        }
        const args = isJsonObject(params['arguments']) ? params['arguments'] : {}
        const controller = new AbortController()
        if (id !== null) inFlight.set(String(id), controller)
        try {
          const result = await callTool(runtime, name, args, cacheDir, controller.signal, policy)
          const payload = result as unknown as JsonObject
          return { jsonrpc: '2.0', id, result: modern ? modernResult(payload) : payload }
        } catch (cause) {
          if (cause instanceof CancelledError || controller.signal.aborted) {
            runtime.writeErr(
              `whichtool mcp: ${name} ${cause instanceof CancelledError ? cause.message : 'cancelled'}\n`,
            )
            return null
          }
          const clean = (text: string): string => redactMachinePaths(text, runtime.cwd())
          const message = clean(cause instanceof Error ? cause.message : String(cause))
          const code = cause instanceof WhichtoolError ? cause.code : 'mcp/tool-failed'
          const hint =
            cause instanceof WhichtoolError && cause.hint !== undefined
              ? clean(cause.hint)
              : undefined
          runtime.writeErr(`whichtool mcp: ${name} failed [${code}]: ${message}\n`)
          const payload = failed(code, message, hint) as unknown as JsonObject
          return { jsonrpc: '2.0', id, result: modern ? modernResult(payload) : payload }
        } finally {
          if (id !== null) inFlight.delete(String(id))
        }
      }

      default:
        return protocolError(id, -32601, `Method not found: ${method}`, modern)
    }
  }

  runtime.writeErr(
    `whichtool ${WHICHTOOL_VERSION} MCP server on stdio. ${MCP_SERVER_TOOLS.length} tools. Dynamic targets: ${policy.allowDynamicTargets ? 'enabled' : 'disabled'}; real provider calls: ${policy.allowPaidRuns ? 'enabled' : 'disabled'}; real-run limits: ${policy.maxTrials} trials, ${policy.maxTools} tools.\n`,
  )

  // Keep consuming notifications while long provider calls are in flight, so cancellation
  // cannot sit unread behind the request it needs to stop.
  const pending = new Set<Promise<void>>()
  for await (const line of runtime.readStdinLines()) {
    if (line.length > MCP_MAX_INBOUND_LINE_CHARS) {
      send(
        protocolError(
          null,
          -32600,
          `Request line exceeds the ${MCP_MAX_INBOUND_LINE_CHARS}-character limit.`,
          isModernEra(era),
        ),
      )
      continue
    }
    const trimmed = line.trim()
    if (trimmed === '') continue

    let payload: unknown
    try {
      payload = JSON.parse(trimmed)
    } catch {
      send(protocolError(null, -32700, 'Parse error', isModernEra(era)))
      continue
    }
    if (!isJsonObject(payload)) {
      send(protocolError(null, -32600, 'Invalid Request', isModernEra(era)))
      continue
    }

    if (
      payload['id'] !== undefined &&
      payload['method'] !== 'notifications/cancelled' &&
      pending.size >= MCP_MAX_IN_FLIGHT
    ) {
      const id = payload['id'] as JsonValue
      send(
        protocolError(
          id,
          -32000,
          `Server busy: at most ${MCP_MAX_IN_FLIGHT} requests may be in flight.`,
          isModernEra(era),
        ),
      )
      continue
    }

    const task = (async () => {
      try {
        const reply = await handle(payload)
        if (reply !== null) send(reply)
      } catch (cause) {
        const message = redactMachinePaths(
          cause instanceof Error ? cause.message : String(cause),
          runtime.cwd(),
        )
        runtime.writeErr(`whichtool mcp: internal error: ${message}\n`)
        const id = payload['id']
        if (id !== undefined) {
          send(protocolError(id as JsonValue, -32603, message, isModernEra(era)))
        }
      }
    })()
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }

  await Promise.all([...pending])
  return 0
}
