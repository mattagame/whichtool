export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

export type JsonSchema = JsonObject

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
  [key: string]: JsonValue | undefined
}

/**
 * Canonical JSON observed on the wire before MCP annotation hints are validated.
 *
 * Keeping this distinct from `ToolAnnotations` lets consumers author conforming hints with
 * useful types while still letting inspection report the malformed values a server served.
 */
export interface ObservedToolAnnotations {
  title?: JsonValue
  readOnlyHint?: JsonValue
  destructiveHint?: JsonValue
  idempotentHint?: JsonValue
  openWorldHint?: JsonValue
  [key: string]: JsonValue | undefined
}

export interface RawTool {
  name?: unknown
  title?: unknown
  description?: unknown
  inputSchema?: unknown
  outputSchema?: unknown
  annotations?: unknown
  _meta?: unknown
  [key: string]: unknown
}

export interface NormalizedTool {
  name: string
  title?: string
  description: string
  hasDescription: boolean
  /** Wire schema: `$ref` intact. Token counting uses this. */
  inputSchema: JsonSchema
  /** `$ref`s inlined, `$defs` stripped. Hash and analysis use this. */
  inputSchemaResolved: JsonSchema
  outputSchema?: JsonSchema
  outputSchemaResolved?: JsonSchema
  annotations?: ObservedToolAnnotations
  originalIndex: number
}

export type Severity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  code: string
  severity: Severity
  message: string

  tool?: string

  tools?: string[]
  detail?: JsonObject
}

export interface TokenizerInfo {
  id: string

  exact: boolean

  approximates: string | null
  note: string
}

export interface ToolTokenBreakdown {
  total: number
  name: number
  description: number
  schema: number

  envelope: number
}

export interface SurfaceTokens {
  tokenizer: TokenizerInfo

  serialization: string
  total: number
  byTool: Record<string, ToolTokenBreakdown>
}

export interface SurfaceSource {
  transport: string

  ref: string
}

/** The normalized `tools/list` of a target, plus everything derived from it. */
export interface Surface {
  hash: string
  tools: NormalizedTool[]
  tokens: SurfaceTokens
  source: SurfaceSource

  diagnostics: Diagnostic[]
}
