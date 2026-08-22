import { isJsonObject } from '../json.js'
import type { Diagnostic, JsonValue, NormalizedTool } from '../types.js'

/**
 * `x-mcp-header` validation.
 *
 * MCP 2026-07-28 lets a server mirror a tool parameter into an `Mcp-Param-{name}` HTTP
 * header so intermediaries can route on it. The rule that makes this whichtool's business:
 * a Streamable HTTP client **MUST reject a tool definition whose `x-mcp-header` violates
 * the constraints, and MUST exclude that tool from the result of `tools/list`**.
 *
 * An excluded tool is one the model never sees. A surface can therefore be smaller in
 * practice than it looks on paper, and nothing else would tell you.
 *
 * Verified against /specification/2026-07-28/server/tools#x-mcp-header and
 * /specification/2026-07-28/basic/transports/streamable-http#custom-headers-from-tool-parameters
 * on 2026-08-17.
 *
 * whichtool reports these tools rather than dropping them: a diagnostic tool that silently
 * removes the thing you broke is the least useful shape it could take. The report says
 * explicitly that a conforming client will exclude them.
 */

const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const ALLOWED_TYPES = new Set(['string', 'integer', 'boolean'])

interface Annotation {
  path: string
  value: JsonValue

  node: Record<string, JsonValue>

  staticallyReachable: boolean
}

/**
 * Collect every `x-mcp-header` in a schema, wherever it is.
 *
 * The walk covers the whole document, not only the legal positions, because an annotation
 * in an illegal position is exactly the thing that invalidates the tool. `staticallyReachable`
 * records whether the path was a pure chain of `properties` keys — a path through `items`,
 * `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else` or `$ref` is not.
 */
export function collectHeaderAnnotations(schema: JsonValue): Annotation[] {
  const found: Annotation[] = []

  const walk = (node: JsonValue, path: string, reachable: boolean): void => {
    if (Array.isArray(node)) {
      for (const [index, child] of node.entries()) walk(child, `${path}/${index}`, false)
      return
    }
    if (!isJsonObject(node)) return

    const annotation = node['x-mcp-header']
    if (annotation !== undefined) {
      found.push({ path, value: annotation, node, staticallyReachable: reachable })
    }

    for (const [key, child] of Object.entries(node)) {
      if (key === 'x-mcp-header') continue
      if (key === 'properties' && isJsonObject(child)) {
        for (const [property, sub] of Object.entries(child)) {
          walk(sub as JsonValue, `${path}/properties/${property}`, reachable)
        }
        continue
      }
      walk(child as JsonValue, `${path}/${key}`, false)
    }
  }

  walk(schema, '', true)
  return found
}

function typeOfNode(node: Record<string, JsonValue>): string | null {
  const type = node['type']
  if (typeof type === 'string') return type
  // A union type such as ["string", "null"] is not a primitive parameter for this purpose.
  if (Array.isArray(type)) return type.map(String).join('|')
  return null
}

export interface HeaderParamAnalysis {
  diagnostics: Diagnostic[]
  /** Tools a conforming Streamable HTTP client will drop from `tools/list`. */
  rejectedTools: string[]
}

export function analyzeHeaderParams(tools: readonly NormalizedTool[]): HeaderParamAnalysis {
  const diagnostics: Diagnostic[] = []
  const rejectedTools: string[] = []

  for (const tool of tools) {
    // The wire schema, not the ref-resolved one: the reachability rule is about where the
    // annotation is written, and resolving refs would move it.
    const annotations = collectHeaderAnnotations(tool.inputSchema)
    if (annotations.length === 0) continue

    const problems: string[] = []
    const seen = new Map<string, string>()

    for (const annotation of annotations) {
      const where = annotation.path === '' ? 'the schema root' : `\`${annotation.path}\``

      if (typeof annotation.value !== 'string') {
        problems.push(`${where}: the value is ${JSON.stringify(annotation.value)}, not a string`)
        continue
      }
      const value = annotation.value

      if (value.length === 0) {
        problems.push(`${where}: the value is empty`)
      } else if (!TCHAR.test(value)) {
        problems.push(
          `${where}: \`${value}\` is not a valid HTTP field-name token (RFC 9110 tchar)`,
        )
      }

      const key = value.toLowerCase()
      const previous = seen.get(key)
      if (previous !== undefined) {
        problems.push(
          `${where}: \`${value}\` collides case-insensitively with the one at \`${previous}\``,
        )
      } else {
        seen.set(key, annotation.path)
      }

      const type = typeOfNode(annotation.node)
      if (type === null) {
        problems.push(`${where}: the annotated property declares no \`type\``)
      } else if (type === 'number') {
        problems.push(`${where}: \`number\` parameters may not be mirrored into a header`)
      } else if (!ALLOWED_TYPES.has(type)) {
        problems.push(`${where}: only string, integer and boolean may be mirrored, not \`${type}\``)
      }

      if (!annotation.staticallyReachable) {
        problems.push(
          `${where}: the property is not statically reachable, so the path has to be a chain of \`properties\` keys and must not pass through \`items\`, \`$ref\`, or a composition or conditional keyword`,
        )
      }
    }

    if (problems.length === 0) {
      diagnostics.push({
        code: 'x-mcp-header/present',
        severity: 'info',
        message: `Tool \`${tool.name}\` mirrors ${annotations.length === 1 ? 'a parameter' : `${annotations.length} parameters`} into HTTP headers. Header values are visible to every intermediary on the path, so nothing sensitive should be among them.`,
        tool: tool.name,
        detail: { count: annotations.length },
      })
      continue
    }

    rejectedTools.push(tool.name)
    diagnostics.push({
      code: 'x-mcp-header/invalid',
      severity: 'error',
      message: `Tool \`${tool.name}\` has an invalid \`x-mcp-header\` annotation, so a conforming Streamable HTTP client must exclude it from tools/list entirely: the model never sees this tool. ${problems.join('; ')}.`,
      tool: tool.name,
      detail: { problems: problems as unknown as JsonValue },
    })
  }

  return { diagnostics, rejectedTools }
}
