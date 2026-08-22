import { canonicalJson } from '../json.js'
import type { JsonValue, NormalizedTool } from '../types.js'

export function surfaceHashInput(tools: readonly NormalizedTool[]): JsonValue {
  return tools
    .map((tool) => {
      const entry: Record<string, JsonValue> = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchemaResolved,
      }
      if (tool.title !== undefined) entry['title'] = tool.title
      if (tool.outputSchemaResolved !== undefined) {
        entry['outputSchema'] = tool.outputSchemaResolved
      }
      if (tool.annotations !== undefined) {
        entry['annotations'] = tool.annotations as unknown as JsonValue
      }
      return entry as JsonValue
    })
    .sort((a, b) => {
      const an = (a as Record<string, JsonValue>)['name'] as string
      const bn = (b as Record<string, JsonValue>)['name'] as string
      return an < bn ? -1 : an > bn ? 1 : 0
    })
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error(
      'WebCrypto (globalThis.crypto.subtle) is unavailable. whichtool needs Node >= 20.11 or Bun.',
    )
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function computeSurfaceHash(tools: readonly NormalizedTool[]): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(surfaceHashInput(tools)))}`
}

/** Short form for display. Never use this for comparison. */
export function shortHash(hash: string, length = 12): string {
  const hex = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash
  return hex.slice(0, length)
}
