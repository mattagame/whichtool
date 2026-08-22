import { canonicalJson } from '../json.js'
import type {
  JsonValue,
  NormalizedTool,
  SurfaceTokens,
  TokenizerInfo,
  ToolTokenBreakdown,
} from '../types.js'

export interface Tokenizer {
  info: TokenizerInfo
  count(text: string): number
}

const PRETOKEN = /'(?:[sdmt]|ll|ve|re|LL|VE|RE|S|D|M|T)|\p{L}+|\p{N}{1,3}|[^\s\p{L}\p{N}]+|\s+/gu

function estimatePretoken(chunk: string): number {
  const first = chunk[0] as string

  if (/\s/.test(first)) {
    const newlines = (chunk.match(/\n/g) ?? []).length
    const horizontal = chunk.length - newlines
    return Math.ceil(newlines / 2) + (horizontal <= 1 ? 0 : Math.ceil((horizontal - 1) / 8))
  }
  if (/\p{N}/u.test(first)) return 1
  if (/\p{L}/u.test(first)) return Math.max(1, Math.ceil(chunk.length / 4))
  return Math.max(1, Math.ceil(chunk.length / 2))
}

export function heuristicTokenizer(approximates: string | null = null): Tokenizer {
  return {
    info: {
      id: 'heuristic-bpe-v1',
      exact: false,
      approximates,
      note:
        'Structural estimate, not a real vocabulary, and not provider-specific. Measured ' +
        'against the same four-tool surface it read 2.4x what OpenAI counted and 0.5x what ' +
        'Anthropic counted: the providers disagree with each other by more than this ' +
        'estimate disagrees with either. Use it to compare tools against each other and to ' +
        'spot bloat; for a bill, read the number your provider reports.',
    },
    count(text: string): number {
      if (text.length === 0) return 0
      let total = 0
      for (const match of text.matchAll(PRETOKEN)) total += estimatePretoken(match[0])
      return total
    },
  }
}

export function getTokenizer(provider: string | null = null): Tokenizer {
  return heuristicTokenizer(provider)
}

export const COUNTING_SERIALIZATION = 'mcp-neutral-compact'

export function serializeToolForCounting(tool: NormalizedTool): string {
  const payload: Record<string, JsonValue> = {
    name: tool.name,
    inputSchema: tool.inputSchema,
  }

  if (tool.hasDescription) payload['description'] = tool.description
  return canonicalJson(payload as JsonValue)
}

export function countToolTokens(tool: NormalizedTool, tokenizer: Tokenizer): ToolTokenBreakdown {
  const total = tokenizer.count(serializeToolForCounting(tool))
  const name = tokenizer.count(JSON.stringify(tool.name))
  const description = tool.hasDescription ? tokenizer.count(JSON.stringify(tool.description)) : 0
  const schema = tokenizer.count(canonicalJson(tool.inputSchema))

  const envelope = Math.max(0, total - name - description - schema)
  return { total, name, description, schema, envelope }
}

export function countSurfaceTokens(
  tools: readonly NormalizedTool[],
  tokenizer: Tokenizer,
): SurfaceTokens {
  const byTool: Record<string, ToolTokenBreakdown> = {}
  let total = 0
  for (const tool of tools) {
    const breakdown = countToolTokens(tool, tokenizer)
    byTool[tool.name] = breakdown
    total += breakdown.total
  }
  return {
    tokenizer: tokenizer.info,
    serialization: COUNTING_SERIALIZATION,
    total,
    byTool,
  }
}
