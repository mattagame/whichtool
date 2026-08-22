import type { ListToolsResult, Transport } from '../transport/types.js'
import type { Surface } from '../types.js'
import { computeSurfaceHash } from './hash.js'
import { normalizeTools } from './normalize.js'
import { countSurfaceTokens, getTokenizer, type Tokenizer } from './tokens.js'

export interface LoadSurfaceOptions {
  tokenizer?: Tokenizer

  provider?: string | null
}

/**
 * transport → normalize → hash → token count.
 *
 * The single call every command starts from. It reads `tools/list` once and nothing else:
 * see the comment on `Transport` for why that is a guarantee and not a convention.
 */
export async function loadSurface(
  transport: Transport,
  options: LoadSurfaceOptions = {},
): Promise<Surface> {
  return surfaceFromListing(await transport.listTools(), transport.kind, transport.ref, options)
}

/**
 * The same pipeline over a listing the caller already has.
 *
 * Exists so a caller that needs the raw `tools/list` as well — `--save-snapshot` does —
 * can read it once and use it twice, instead of asking the server a second time. Two calls
 * would also risk a snapshot that disagrees with the report beside it.
 */
export async function surfaceFromListing(
  listed: ListToolsResult,
  transportKind: string,
  ref: string,
  options: LoadSurfaceOptions = {},
): Promise<Surface> {
  const normalized = normalizeTools(listed.tools)
  const tokenizer = options.tokenizer ?? getTokenizer(options.provider ?? null)

  return {
    hash: await computeSurfaceHash(normalized.tools),
    tools: normalized.tools,
    tokens: countSurfaceTokens(normalized.tools, tokenizer),
    source: { transport: transportKind, ref },
    diagnostics: [...listed.diagnostics, ...normalized.diagnostics],
  }
}
