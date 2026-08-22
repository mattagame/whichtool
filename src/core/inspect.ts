import { isJsonObject } from './json.js'
import { DEFAULT_MAX_TOOLS } from './eval/options.js'
import {
  analyzeAnnotations,
  classifyName,
  type AnnotationCoverage,
  type NameSemantics,
} from './static/annotations.js'
import { analyzeDeprecations, type DeprecationAnalysis } from './static/deprecated.js'
import { analyzeHeaderParams } from './static/header-params.js'
import { analyzeOverlap, type OverlapPair } from './static/overlap.js'
import type {
  Diagnostic,
  NormalizedTool,
  ObservedToolAnnotations,
  Severity,
  Surface,
  SurfaceSource,
  SurfaceTokens,
  ToolTokenBreakdown,
} from './types.js'

export const INSPECT_SCHEMA_VERSION = 'whichtool.inspect/1'

export interface InspectToolSummary {
  name: string
  title?: string
  hasDescription: boolean
  descriptionLength: number

  semantics: NameSemantics
  parameterCount: number
  requiredParameterCount: number
  annotations?: ObservedToolAnnotations
  tokens: ToolTokenBreakdown

  tokenShare: number

  servedIndex: number
}

export interface ThresholdCheck {
  name: string
  limit: number
  actual: number
  ok: boolean
}

export interface InspectReport {
  schemaVersion: string
  target: SurfaceSource
  surface: {
    hash: string
    toolCount: number
    tools: InspectToolSummary[]
  }
  tokens: SurfaceTokens
  annotations: {
    coverage: AnnotationCoverage
    caveat: string
  }
  overlap: {
    method: string
    pairsConsidered: number
    pairsReported: number
    pairs: OverlapPair[]
  }
  deprecations: DeprecationAnalysis
  headerParams: {
    rejectedTools: string[]
  }
  diagnostics: Diagnostic[]
  thresholds: ThresholdCheck[]
  /** Static analysis completed without an error-severity diagnostic. */
  analysisOk: boolean
  /** Whether every configured threshold passed. */
  thresholdsOk: boolean
  ok: boolean
}

export interface InspectOptions {
  maxContextTokens?: number
  maxOverlapPairs?: number
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

function countParameters(tool: NormalizedTool): { total: number; required: number } {
  const schema = tool.inputSchemaResolved
  const properties = schema['properties']
  const total = isJsonObject(properties) ? Object.keys(properties).length : 0
  const required = schema['required']
  return { total, required: Array.isArray(required) ? required.length : 0 }
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (bySeverity !== 0) return bySeverity
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    const aTarget = a.tool ?? a.tools?.join(',') ?? ''
    const bTarget = b.tool ?? b.tools?.join(',') ?? ''
    if (aTarget !== bTarget) return aTarget < bTarget ? -1 : 1
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  })
}

export function topFindings(report: InspectReport, limit = 3): Diagnostic[] {
  return report.diagnostics.filter((d) => d.severity !== 'info').slice(0, limit)
}

export function buildInspectReport(surface: Surface, options: InspectOptions = {}): InspectReport {
  const annotations = analyzeAnnotations(surface.tools)
  const overlapOptions =
    options.maxOverlapPairs === undefined ? {} : { maxPairs: options.maxOverlapPairs }
  const overlap = analyzeOverlap(surface.tools, overlapOptions)
  const deprecations = analyzeDeprecations(surface.tools)
  const headerParams = analyzeHeaderParams(surface.tools)

  const total = surface.tokens.total
  const tools: InspectToolSummary[] = surface.tools.map((tool) => {
    const params = countParameters(tool)
    const tokens = surface.tokens.byTool[tool.name] ?? {
      total: 0,
      name: 0,
      description: 0,
      schema: 0,
      envelope: 0,
    }
    const summary: InspectToolSummary = {
      name: tool.name,
      hasDescription: tool.hasDescription,
      descriptionLength: tool.description.length,
      semantics: classifyName(tool.name).semantics,
      parameterCount: params.total,
      requiredParameterCount: params.required,
      tokens,
      tokenShare: total > 0 ? tokens.total / total : 0,
      servedIndex: tool.originalIndex,
    }
    if (tool.title !== undefined) summary.title = tool.title
    if (tool.annotations !== undefined) summary.annotations = tool.annotations
    return summary
  })

  const thresholds: ThresholdCheck[] = []
  if (options.maxContextTokens !== undefined) {
    thresholds.push({
      name: 'maxContextTokens',
      limit: options.maxContextTokens,
      actual: total,
      ok: total <= options.maxContextTokens,
    })
  }

  const analysisDiagnostics: Diagnostic[] = [
    ...surface.diagnostics,
    ...(surface.tools.length > DEFAULT_MAX_TOOLS
      ? [
          {
            code: 'surface/large-tool-set',
            severity: 'warning' as const,
            message: `Surface exposes ${surface.tools.length} tools, above the cautious ${DEFAULT_MAX_TOOLS}-tool review threshold. This is not a universal model limit, but larger choices can increase prompt cost and routing confusion; inspect the overlap findings and require an explicit override before a measured run.`,
            detail: { actual: surface.tools.length, reviewThreshold: DEFAULT_MAX_TOOLS },
          },
        ]
      : []),
    ...annotations.diagnostics,
    ...overlap.diagnostics,
    ...deprecations.diagnostics,
    ...headerParams.diagnostics,
  ]
  const analysisOk = !analysisDiagnostics.some((diagnostic) => diagnostic.severity === 'error')
  const thresholdsOk = thresholds.every((check) => check.ok)
  const diagnostics = sortDiagnostics([
    ...analysisDiagnostics,
    ...thresholds
      .filter((check) => !check.ok)
      .map<Diagnostic>((check) => ({
        code: `threshold/${check.name}`,
        severity: 'error',
        message: `Surface costs ~${check.actual} tokens, over the ${check.limit}-token budget.`,
        detail: { limit: check.limit, actual: check.actual },
      })),
  ])

  return {
    schemaVersion: INSPECT_SCHEMA_VERSION,
    target: surface.source,
    surface: { hash: surface.hash, toolCount: surface.tools.length, tools },
    tokens: surface.tokens,
    annotations: { coverage: annotations.coverage, caveat: annotations.caveat },
    overlap: {
      method: overlap.method,
      pairsConsidered: overlap.pairsConsidered,
      pairsReported: overlap.pairsReported,
      pairs: overlap.pairs,
    },
    deprecations,
    headerParams: { rejectedTools: headerParams.rejectedTools },
    diagnostics,
    thresholds,
    analysisOk,
    thresholdsOk,
    ok: analysisOk && thresholdsOk,
  }
}
