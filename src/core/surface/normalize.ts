import { isJsonObject, resolvePointer, toJsonValue } from '../json.js'
import type {
  Diagnostic,
  JsonObject,
  JsonSchema,
  JsonValue,
  NormalizedTool,
  ObservedToolAnnotations,
  RawTool,
} from '../types.js'

const MAX_RESOLVED_NODES = 200_000

export function normalizeDescription(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function canonicalizeSchema(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeSchema)
  if (!isJsonObject(value)) return value
  const out: JsonObject = {}
  for (const key of Object.keys(value).sort()) {
    const child = value[key] as JsonValue
    if (key === 'required' && Array.isArray(child) && child.every((v) => typeof v === 'string')) {
      out[key] = [...(child as string[])].sort()
      continue
    }
    out[key] = canonicalizeSchema(child)
  }
  return out
}

interface ResolveResult {
  schema: JsonSchema
  unresolved: Array<{ ref: string; reason: 'external' | 'cycle' | 'missing' | 'too-large' }>
}

export function resolveInternalRefs(schema: JsonSchema): ResolveResult {
  const unresolved: ResolveResult['unresolved'] = []
  const stack: string[] = []
  let nodeBudget = MAX_RESOLVED_NODES
  let budgetExhausted = false

  const walk = (node: JsonValue): JsonValue => {
    if (budgetExhausted) return node
    if (--nodeBudget <= 0) {
      budgetExhausted = true
      unresolved.push({ ref: '*', reason: 'too-large' })
      return node
    }
    if (Array.isArray(node)) return node.map(walk)
    if (!isJsonObject(node)) return node

    const ref = node['$ref']
    if (typeof ref === 'string') {
      const siblings: JsonObject = {}
      for (const [key, child] of Object.entries(node)) {
        if (key !== '$ref') siblings[key] = child as JsonValue
      }

      if (!ref.startsWith('#')) {
        unresolved.push({ ref, reason: 'external' })
        return walkObject(node)
      }
      if (stack.includes(ref)) {
        unresolved.push({ ref, reason: 'cycle' })
        return walkObject(node)
      }
      const target = resolvePointer(schema, ref)
      if (target === undefined) {
        unresolved.push({ ref, reason: 'missing' })
        return walkObject(node)
      }

      stack.push(ref)
      const resolved = walk(target)
      stack.pop()

      if (isJsonObject(resolved)) {
        return { ...resolved, ...(walkObject(siblings) as JsonObject) }
      }
      return resolved
    }

    return walkObject(node)
  }

  const walkObject = (node: JsonObject): JsonObject => {
    const out: JsonObject = {}
    for (const [key, child] of Object.entries(node)) {
      out[key] =
        key === '$defs' || key === 'definitions' ? (child as JsonValue) : walk(child as JsonValue)
    }
    return out
  }

  let resolved = walk(schema)
  if (!isJsonObject(resolved)) resolved = {}

  const seen = new Set<string>()
  const deduped = unresolved.filter((item) => {
    const key = `${item.reason}:${item.ref}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (deduped.length === 0) {
    resolved = stripDefs(resolved) as JsonObject
  }
  return { schema: canonicalizeSchema(resolved) as JsonSchema, unresolved: deduped }
}

function stripDefs(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stripDefs)
  if (!isJsonObject(value)) return value
  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '$defs' || key === 'definitions') continue
    out[key] = stripDefs(child as JsonValue)
  }
  return out
}

function normalizeAnnotations(value: unknown): ObservedToolAnnotations | undefined {
  if (!isJsonObject(value)) return undefined
  const json = toJsonValue(value)
  if (!isJsonObject(json)) return undefined
  return canonicalizeSchema(json) as ObservedToolAnnotations
}

function normalizeSchema(value: unknown): JsonSchema | undefined {
  const json = toJsonValue(value)
  if (!isJsonObject(json)) return undefined
  return canonicalizeSchema(json) as JsonSchema
}

export interface NormalizeResult {
  tools: NormalizedTool[]
  diagnostics: Diagnostic[]
}

/**
 * Bring a served `tools/list` into canonical form.
 *
 * Tools are sorted by name so that a server reordering its registration calls does not
 * look like a changed surface. The served position is kept on `originalIndex`, because
 * position influences model choice and the trial planner needs to know what "as served"
 * was before it permutes (SPEC §5.4).
 */
export function normalizeTools(rawTools: readonly RawTool[]): NormalizeResult {
  const diagnostics: Diagnostic[] = []
  const seenNames = new Map<string, number>()
  const tools: NormalizedTool[] = []

  rawTools.forEach((raw, index) => {
    if (!isJsonObject(raw)) {
      diagnostics.push({
        code: 'surface/malformed-tool',
        severity: 'error',
        message: `Tool at index ${index} is not an object and was skipped.`,
        detail: { index },
      })
      return
    }
    const name = raw.name
    if (typeof name !== 'string' || name.length === 0) {
      diagnostics.push({
        code: 'surface/missing-tool-name',
        severity: 'error',
        message: `Tool at index ${index} has no usable \`name\` and was skipped.`,
        detail: { index },
      })
      return
    }
    const previous = seenNames.get(name)
    if (previous !== undefined) {
      diagnostics.push({
        code: 'surface/duplicate-tool-name',
        severity: 'error',
        message: `Duplicate tool name \`${name}\` at index ${index}; the entry at index ${previous} is the one kept.`,
        tool: name,
        detail: { index, keptIndex: previous },
      })
      return
    }
    seenNames.set(name, index)

    const hasDescription = typeof raw.description === 'string'
    const description = hasDescription ? normalizeDescription(raw.description as string) : ''
    if (typeof raw.description !== 'string' && raw.description !== undefined) {
      diagnostics.push({
        code: 'surface/non-string-description',
        severity: 'warning',
        message: `Tool \`${name}\` has a non-string \`description\`; treated as absent.`,
        tool: name,
      })
    }

    const inputSchema = normalizeSchema(raw.inputSchema) ?? { type: 'object' }
    if (raw.inputSchema === undefined) {
      diagnostics.push({
        code: 'surface/missing-input-schema',
        severity: 'warning',
        message: `Tool \`${name}\` has no \`inputSchema\`; an empty object schema was assumed.`,
        tool: name,
      })
    }
    const outputSchema = normalizeSchema(raw.outputSchema)

    const inputResolved = resolveInternalRefs(inputSchema)
    reportUnresolved(diagnostics, name, 'inputSchema', inputResolved.unresolved)

    const tool: NormalizedTool = {
      name,
      description,
      hasDescription,
      inputSchema,
      inputSchemaResolved: inputResolved.schema,
      originalIndex: index,
    }

    if (typeof raw.title === 'string') tool.title = normalizeDescription(raw.title)
    const annotations = normalizeAnnotations(raw.annotations)
    if (annotations) tool.annotations = annotations
    if (outputSchema) {
      tool.outputSchema = outputSchema
      const outputResolved = resolveInternalRefs(outputSchema)
      reportUnresolved(diagnostics, name, 'outputSchema', outputResolved.unresolved)
      tool.outputSchemaResolved = outputResolved.schema
    }

    tools.push(tool)
  })

  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { tools, diagnostics }
}

function reportUnresolved(
  diagnostics: Diagnostic[],
  toolName: string,
  field: string,
  unresolved: ResolveResult['unresolved'],
): void {
  for (const item of unresolved) {
    diagnostics.push({
      code: `surface/unresolved-ref-${item.reason}`,
      severity: item.reason === 'too-large' ? 'warning' : 'info',
      message:
        item.reason === 'too-large'
          ? `Tool \`${toolName}\`: \`${field}\` expands past the inlining budget; analysis uses the partially resolved schema.`
          : `Tool \`${toolName}\`: \`${field}\` keeps an unresolved \`$ref\` (${item.ref}, ${item.reason}).`,
      tool: toolName,
      detail: { field, ref: item.ref, reason: item.reason },
    })
  }
}
