import type { Diagnostic, NormalizedTool, ObservedToolAnnotations } from '../types.js'

export const HINT_DEFAULTS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const

const KNOWN_ANNOTATION_KEYS = new Set([
  'title',
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
])

const READ_VERBS = new Set([
  'browse',
  'check',
  'compare',
  'count',
  'describe',
  'diff',
  'download',
  'exists',
  'explain',
  'export',
  'fetch',
  'find',
  'get',
  'has',
  'head',
  'inspect',
  'list',
  'lookup',
  'peek',
  'preview',
  'query',
  'read',
  'resolve',
  'retrieve',
  'search',
  'show',
  'stat',
  'summarize',
  'validate',
  'view',
])

const MUTATE_VERBS = new Set([
  'add',
  'apply',
  'approve',
  'archive',
  'assign',
  'cancel',
  'charge',
  'close',
  'copy',
  'create',
  'disable',
  'edit',
  'enable',
  'execute',
  'generate',
  'grant',
  'import',
  'insert',
  'install',
  'invite',
  'invoke',
  'lock',
  'mark',
  'merge',
  'move',
  'open',
  'patch',
  'pay',
  'post',
  'publish',
  'put',
  'refresh',
  'refund',
  'register',
  'reject',
  'rename',
  'reset',
  'restart',
  'restore',
  'revoke',
  'rotate',
  'run',
  'schedule',
  'send',
  'set',
  'start',
  'stop',
  'submit',
  'sync',
  'toggle',
  'transfer',
  'trigger',
  'uninstall',
  'unlock',
  'update',
  'upload',
  'upsert',
  'write',
])

const DESTRUCTIVE_VERBS = new Set([
  'clear',
  'delete',
  'destroy',
  'drop',
  'erase',
  'kill',
  'overwrite',
  'prune',
  'purge',
  'remove',
  'reset',
  'revoke',
  'terminate',
  'truncate',
  'uninstall',
  'wipe',
])

export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase())
}

export type NameSemantics = 'read' | 'mutate' | 'destructive' | 'unknown'

export function classifyName(name: string): { semantics: NameSemantics; verb: string | null } {
  const tokens = nameTokens(name)
  const leading = tokens[0]
  if (leading !== undefined) {
    if (DESTRUCTIVE_VERBS.has(leading)) return { semantics: 'destructive', verb: leading }
    if (MUTATE_VERBS.has(leading)) return { semantics: 'mutate', verb: leading }
    if (READ_VERBS.has(leading)) return { semantics: 'read', verb: leading }
  }
  for (const token of tokens) {
    if (DESTRUCTIVE_VERBS.has(token)) return { semantics: 'destructive', verb: token }
  }
  for (const token of tokens) {
    if (MUTATE_VERBS.has(token)) return { semantics: 'mutate', verb: token }
  }
  for (const token of tokens) {
    if (READ_VERBS.has(token)) return { semantics: 'read', verb: token }
  }
  return { semantics: 'unknown', verb: null }
}

export interface AnnotationCoverage {
  toolCount: number

  annotated: number
  byHint: Record<'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint', number>
}

export interface AnnotationAnalysis {
  coverage: AnnotationCoverage
  diagnostics: Diagnostic[]

  caveat: string
}

const CAVEAT =
  'Annotations are hints, not guarantees: the MCP spec is explicit that a client must not ' +
  'rely on them as a security boundary. whichtool checks their internal consistency, not ' +
  'their truthfulness; only running the tool could establish that, and whichtool never does.'

function hint(annotations: ObservedToolAnnotations | undefined, key: string): unknown {
  if (!annotations) return undefined
  return annotations[key]
}

export function analyzeAnnotations(tools: readonly NormalizedTool[]): AnnotationAnalysis {
  const diagnostics: Diagnostic[] = []
  const pendingReadHints: Diagnostic[] = []
  const coverage: AnnotationCoverage = {
    toolCount: tools.length,
    annotated: 0,
    byHint: { readOnlyHint: 0, destructiveHint: 0, idempotentHint: 0, openWorldHint: 0 },
  }

  for (const tool of tools) {
    const annotations = tool.annotations
    let declaredHints = 0
    for (const key of [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ] as const) {
      const value = hint(annotations, key)
      if (value === undefined) continue
      if (typeof value !== 'boolean') {
        diagnostics.push({
          code: 'annotations/non-boolean-hint',
          severity: 'warning',
          message: `Tool \`${tool.name}\`: \`${key}\` is \`${JSON.stringify(value)}\`, not a boolean; clients will fall back to the default (${String(HINT_DEFAULTS[key])}).`,
          tool: tool.name,
          detail: { hint: key, value: JSON.stringify(value) },
        })
        continue
      }
      declaredHints += 1
      coverage.byHint[key] += 1
    }
    if (declaredHints > 0) coverage.annotated += 1

    if (annotations) {
      for (const key of Object.keys(annotations)) {
        if (KNOWN_ANNOTATION_KEYS.has(key)) continue
        diagnostics.push({
          code: 'annotations/unknown-key',
          severity: 'info',
          message: `Tool \`${tool.name}\`: \`annotations.${key}\` is not a known MCP annotation; clients will ignore it.`,
          tool: tool.name,
          detail: { key },
        })
      }
    }

    const readOnly = hint(annotations, 'readOnlyHint')
    const destructive = hint(annotations, 'destructiveHint')
    const { semantics, verb } = classifyName(tool.name)

    if (readOnly === true && destructive === true) {
      diagnostics.push({
        code: 'annotations/contradictory-read-only-destructive',
        severity: 'error',
        message: `Tool \`${tool.name}\` declares both \`readOnlyHint: true\` and \`destructiveHint: true\`. A read-only tool cannot be destructive; clients ignore \`destructiveHint\` when \`readOnlyHint\` is true, so one of the two is a lie about the tool.`,
        tool: tool.name,
      })
    }

    if (readOnly === true && (semantics === 'mutate' || semantics === 'destructive')) {
      diagnostics.push({
        code: 'annotations/read-only-with-mutating-name',
        severity: 'warning',
        message: `Tool \`${tool.name}\` declares \`readOnlyHint: true\` but its name leads with \`${verb}\`, which reads as a write. Either the hint or the name is misleading the model.`,
        tool: tool.name,
        detail: { verb: verb ?? '', semantics },
      })
    }

    if (readOnly === false && semantics === 'read') {
      diagnostics.push({
        code: 'annotations/write-hint-with-read-name',
        severity: 'info',
        message: `Tool \`${tool.name}\` leads with \`${verb}\` but declares \`readOnlyHint: false\`, so clients treat it as a write and may prompt for confirmation.`,
        tool: tool.name,
        detail: { verb: verb ?? '', semantics },
      })
    }

    if (semantics === 'destructive' && readOnly !== true && destructive === false) {
      diagnostics.push({
        code: 'annotations/destructive-name-declared-safe',
        severity: 'warning',
        message: `Tool \`${tool.name}\` leads with \`${verb}\` but declares \`destructiveHint: false\`, which tells clients to skip the confirmation step.`,
        tool: tool.name,
        detail: { verb: verb ?? '' },
      })
    }

    if (semantics === 'read' && readOnly === undefined) {
      pendingReadHints.push({
        code: 'annotations/read-tool-missing-read-only-hint',
        severity: 'info',
        message: `Tool \`${tool.name}\` reads by name but declares no \`readOnlyHint\`; clients default to \`false\` and treat it as a potentially destructive write.`,
        tool: tool.name,
        detail: { verb: verb ?? '' },
      })
    }
  }

  if (coverage.annotated > 0) diagnostics.push(...pendingReadHints)

  if (coverage.toolCount > 0 && coverage.annotated === 0) {
    diagnostics.push({
      code: 'annotations/absent-surface-wide',
      severity: 'warning',
      message: `No tool on this surface declares any annotation. Clients therefore assume the documented defaults for every one of them (not read-only, potentially destructive, not idempotent, open-world), which changes the confirmation UX for all ${coverage.toolCount} tools without the maintainer choosing it.`,
      tools: tools.map((tool) => tool.name),
      detail: { defaults: { ...HINT_DEFAULTS } },
    })
  } else if (coverage.annotated > 0 && coverage.annotated < coverage.toolCount) {
    const missing = tools
      .filter((tool) => {
        const annotations = tool.annotations
        return (
          !annotations ||
          !Object.keys(annotations).some((key) => KNOWN_ANNOTATION_KEYS.has(key) && key !== 'title')
        )
      })
      .map((tool) => tool.name)
    diagnostics.push({
      code: 'annotations/partial-coverage',
      severity: 'warning',
      message: `${coverage.annotated} of ${coverage.toolCount} tools declare annotations. The rest silently fall back to the defaults, so the surface is inconsistent about what a client should confirm.`,
      tools: missing,
      detail: { annotated: coverage.annotated, total: coverage.toolCount },
    })
  }

  return { coverage, diagnostics, caveat: CAVEAT }
}
