export { defineConfig } from './config.js'
export type {
  ProviderConfig,
  ReportConfig,
  ReportFormat,
  TargetSpec,
  ThresholdsConfig,
  TrialsConfig,
  WhichtoolConfig,
} from './config.js'

export { NotImplementedError, WhichtoolError } from './core/errors.js'
export { WHICHTOOL_VERSION } from './version.js'

export type {
  Diagnostic,
  JsonObject,
  JsonSchema,
  JsonValue,
  NormalizedTool,
  ObservedToolAnnotations,
  RawTool,
  Severity,
  Surface,
  SurfaceSource,
  SurfaceTokens,
  TokenizerInfo,
  ToolAnnotations,
  ToolTokenBreakdown,
} from './core/types.js'

export {
  createHttpTransport,
  createSnapshotTransport,
  createStdioTransport,
  createTransport,
  MCP_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  redactUrl,
  snapshotTransportFromData,
  splitCommandLine,
} from './core/transport/index.js'
export type {
  ListToolsResult,
  McpProcess,
  SpawnSpec,
  Transport,
  TransportDeps,
  TransportKind,
} from './core/transport/index.js'

export { loadSurface, surfaceFromListing } from './core/surface/fetch.js'
export { computeSurfaceHash, shortHash } from './core/surface/hash.js'
export { normalizeTools } from './core/surface/normalize.js'
export { countSurfaceTokens, getTokenizer, heuristicTokenizer } from './core/surface/tokens.js'
export type { Tokenizer } from './core/surface/tokens.js'

export { analyzeAnnotations, classifyName, nameTokens } from './core/static/annotations.js'
export type {
  AnnotationAnalysis,
  AnnotationCoverage,
  NameSemantics,
} from './core/static/annotations.js'
export { analyzeDeprecations } from './core/static/deprecated.js'
export type { DeprecationAnalysis, DeprecationRule } from './core/static/deprecated.js'
export { analyzeHeaderParams } from './core/static/header-params.js'
export type { HeaderParamAnalysis } from './core/static/header-params.js'
export {
  analyzeOverlap,
  diceSimilarity,
  HIGH_OVERLAP,
  NOTABLE_OVERLAP,
} from './core/static/overlap.js'
export type { OverlapAnalysis, OverlapPair } from './core/static/overlap.js'
export {
  buildInspectReport,
  INSPECT_SCHEMA_VERSION,
  sortDiagnostics,
  topFindings,
} from './core/inspect.js'
export type {
  InspectOptions,
  InspectReport,
  InspectToolSummary,
  ThresholdCheck,
} from './core/inspect.js'

export { parseTaskSet } from './core/tasks/load.js'
export {
  countDistractors,
  expectedTools,
  TASK_SET_VERSION,
  taskSetToJson,
  taskSetToYaml,
  tasksMatchingTags,
} from './core/tasks/schema.js'
export type { Task, TaskSet } from './core/tasks/schema.js'
export { validateTaskSet } from './core/tasks/validate.js'
export type { TaskSetValidation } from './core/tasks/validate.js'
export { generateTaskSet } from './core/tasks/generate.js'
export type { GenerateOptions, GenerationResult } from './core/tasks/generate.js'
export { mutateTasks, MUTATION_NAMES } from './core/tasks/mutate.js'
export type { Mutation, MutateOptions, MutationResult } from './core/tasks/mutate.js'
export { parseYamlSubset } from './core/tasks/yaml.js'

export { createRandom, hashString, orderTools, permute, planTrials } from './core/eval/planner.js'
export type { PlanOptions, Trial, TrialPlan } from './core/eval/planner.js'
export { runTrials } from './core/eval/runner.js'
export type { RunnerOptions, RunnerResult, TrialOutcome } from './core/eval/runner.js'
export {
  MAX_CONCURRENCY,
  MAX_PLANNED_TRIALS,
  MAX_REPEAT,
  MAX_TEMPERATURE,
  MIN_CONCURRENCY,
  MIN_REPEAT,
  MIN_TEMPERATURE,
} from './core/eval/options.js'
export { scoreTrials } from './core/eval/scorer.js'
export type { ArgumentCheck, ScoredTrial, Verdict } from './core/eval/scorer.js'
export {
  computeMetrics,
  MIN_TRIALS_PER_TOOL,
  NONE,
  PHANTOM,
  proportion,
  thinlyMeasuredTools,
} from './core/eval/metrics.js'
export type {
  ConfusionPair,
  PositionBucket,
  Proportion,
  RunMetrics,
  ToolMetrics,
} from './core/eval/metrics.js'
export {
  buildRunReport,
  DEFAULT_MAX_ERROR_RATE,
  DEFAULT_MIN_SCORED,
  estimateRun,
  RUN_SCHEMA_VERSION,
  validateRunThresholds,
} from './core/run.js'
export type {
  DryRunEstimate,
  Reproducibility,
  RunExecutionStatus,
  RunReport,
  RunThresholdCheck,
  RunThresholds,
} from './core/run.js'

export { createKeywordProvider, createMockProvider } from './core/providers/mock.js'
export type { MockProvider, MockScript, ScriptedPick } from './core/providers/mock.js'
export { createOpenAiCompatibleProvider } from './core/providers/openai-compatible.js'
export type { OpenAiCompatibleOptions } from './core/providers/openai-compatible.js'
export { createOpenAiResponsesProvider } from './core/providers/openai-responses.js'
export type { OpenAiResponsesOptions } from './core/providers/openai-responses.js'
export { ProviderError, toOpenAiTool } from './core/providers/types.js'
export type {
  PickRequest,
  PickResult,
  Provider,
  ProviderCapabilities,
  RecordedToolCall,
} from './core/providers/types.js'

export { diffRuns, DIFF_SCHEMA_VERSION, parseRunReport } from './core/diff.js'
export type { RunDiff, ToolDelta } from './core/diff.js'
export { createMemoryCache, withCache } from './core/cache/provider.js'
export { trialCacheKey } from './core/cache/types.js'
export type { CachedPick, CacheInfo, TrialCache } from './core/cache/types.js'

export { renderInspectTerminal } from './core/report/terminal.js'
export type { TerminalOptions } from './core/report/terminal.js'
export { renderRunTerminal } from './core/report/run-terminal.js'
export type { RunTerminalOptions } from './core/report/run-terminal.js'
export { renderDiffMarkdown, renderDiffTerminal } from './core/report/diff-terminal.js'
export { renderInspectMarkdown, renderRunMarkdown } from './core/report/markdown.js'
export { renderRunHtml } from './core/report/html.js'
export { renderInspectJUnit, renderRunJUnit } from './core/report/junit.js'
export {
  badgeForInspect,
  badgeForOverTrigger,
  badgeForRun,
  renderBadgeJson,
} from './core/report/badge.js'
export type { Badge } from './core/report/badge.js'

export { MCP_SERVER_TOOLS } from './core/mcp-server/tools.js'
