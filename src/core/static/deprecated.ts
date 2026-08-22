import type { Diagnostic, NormalizedTool } from '../types.js'

export interface DeprecationRule {
  code: string
  severity: Diagnostic['severity']

  message: string

  applies(tool: NormalizedTool): boolean
}

export const RULES_SPEC_REVISION = '2026-07-28'

export const RULES_VERIFIED_ON = '2026-08-17'

export interface RegistryEntry {
  feature: string
  deprecatedIn: string
  migration: string
  /** Whether the feature can appear in a `tools/list` response or a `Tool` definition. */
  surfaceVisible: boolean
}

export const REGISTRY: readonly RegistryEntry[] = [
  {
    feature: 'Roots',
    deprecatedIn: '2026-07-28',
    migration:
      'Pass directories or files via tool parameters, resource URIs, or server configuration',
    surfaceVisible: false,
  },
  {
    feature: 'Sampling',
    deprecatedIn: '2026-07-28',
    migration: 'Integrate directly with LLM provider APIs',
    surfaceVisible: false,
  },
  {
    feature: 'Logging',
    deprecatedIn: '2026-07-28',
    migration: 'Log to stderr on stdio; use OpenTelemetry for observability',
    surfaceVisible: false,
  },
  {
    feature: 'Dynamic Client Registration',
    deprecatedIn: '2026-07-28',
    migration: 'Client ID Metadata Documents',
    surfaceVisible: false,
  },
  {
    feature: 'Sampling includeContext: "thisServer" / "allServers"',
    deprecatedIn: '2025-11-25',
    migration: 'Omit the field or use "none"',
    surfaceVisible: false,
  },
  {
    feature: 'HTTP+SSE transport (2024-11-05)',
    deprecatedIn: '2025-03-26',
    migration: 'Streamable HTTP',
    surfaceVisible: false,
  },
]

export const RULES: readonly DeprecationRule[] = []

export interface DeprecationAnalysis {
  checked: boolean
  specRevision: string | null
  verifiedOn: string | null
  ruleCount: number
  registrySize: number
  note: string
  diagnostics: Diagnostic[]
}

export function analyzeDeprecations(tools: readonly NormalizedTool[]): DeprecationAnalysis {
  const diagnostics: Diagnostic[] = []
  for (const tool of tools) {
    for (const rule of RULES) {
      if (!rule.applies(tool)) continue
      diagnostics.push({
        code: rule.code,
        severity: rule.severity,
        message: `Tool \`${tool.name}\`: ${rule.message}`,
        tool: tool.name,
      })
    }
  }

  const note =
    RULES.length > 0
      ? `Checked against MCP ${RULES_SPEC_REVISION} (registry read ${RULES_VERIFIED_ON}).`
      : `Checked against MCP ${RULES_SPEC_REVISION} (registry read ${RULES_VERIFIED_ON}): none of the ` +
        `${REGISTRY.length} deprecated features is visible in a tools/list response or a tool ` +
        `definition. They are all client-, authorization- or transport-level, so there is nothing ` +
        `on a surface to flag. The deprecated HTTP+SSE transport is refused by \`--transport legacy-sse\` instead.`

  return {
    checked: true,
    specRevision: RULES_SPEC_REVISION,
    verifiedOn: RULES_VERIFIED_ON,
    ruleCount: RULES.length,
    registrySize: REGISTRY.length,
    note,
    diagnostics,
  }
}
