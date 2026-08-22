import type { Diagnostic, NormalizedTool } from '../types.js'
import { nameTokens } from './annotations.js'

const STOPWORDS = new Set([
  'a',
  'about',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'for',
  'from',
  'given',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'one',
  'only',
  'or',
  'provided',
  'return',
  'returns',
  'specified',
  'that',
  'the',
  'their',
  'them',
  'then',
  'this',
  'to',
  'use',
  'used',
  'using',
  'when',
  'which',
  'will',
  'with',
  'you',
  'your',
])

export const HIGH_OVERLAP = 0.6

export const NOTABLE_OVERLAP = 0.4

const DEFAULT_MAX_PAIRS = 20

function normalizeForOverlap(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function trigrams(text: string): Map<string, number> {
  const padded = `  ${text} `
  const counts = new Map<string, number>()
  for (let i = 0; i + 3 <= padded.length; i += 1) {
    const gram = padded.slice(i, i + 3)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

function size(counts: Map<string, number>): number {
  let total = 0
  for (const value of counts.values()) total += value
  return total
}

/** Sørensen–Dice over character-trigram multisets. 1 means textually identical. */
export function diceSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  const left = trigrams(a)
  const right = trigrams(b)
  let shared = 0
  for (const [gram, count] of left) {
    const other = right.get(gram)
    if (other !== undefined) shared += Math.min(count, other)
  }
  const denominator = size(left) + size(right)
  return denominator === 0 ? 0 : (2 * shared) / denominator
}

function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of normalizeForOverlap(text).split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOPWORDS.has(word)) continue
    out.add(word)
  }
  return out
}

/** The text the overlap score is computed on: name (de-cased, de-punctuated) plus description. */
export function overlapText(tool: NormalizedTool): string {
  return normalizeForOverlap(`${nameTokens(tool.name).join(' ')} ${tool.description}`)
}

export interface OverlapPair {
  tools: [string, string]
  /** Dice similarity over name-plus-description. This is the score the report sorts by. */
  score: number
  nameScore: number
  descriptionScore: number
  identicalDescription: boolean
  /** Terms both tools use that few other tools on this surface use. */
  distinctiveSharedTerms: string[]
}

export interface OverlapAnalysis {
  method: string
  /** Every unordered pair was scored; this says how many, so the list below has a denominator. */
  pairsConsidered: number
  pairsReported: number
  pairs: OverlapPair[]
  diagnostics: Diagnostic[]
}

export interface OverlapOptions {
  maxPairs?: number
}

export function analyzeOverlap(
  tools: readonly NormalizedTool[],
  options: OverlapOptions = {},
): OverlapAnalysis {
  const maxPairs = options.maxPairs ?? DEFAULT_MAX_PAIRS
  const diagnostics: Diagnostic[] = []

  const prepared = tools.map((tool) => ({
    tool,
    combined: overlapText(tool),
    name: nameTokens(tool.name).join(' '),
    description: normalizeForOverlap(tool.description),
    words: words(`${nameTokens(tool.name).join(' ')} ${tool.description}`),
  }))

  // Document frequency across the surface: a term shared by two tools is only
  // interesting if it is not shared by every tool.
  const documentFrequency = new Map<string, number>()
  for (const entry of prepared) {
    for (const word of entry.words) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1)
    }
  }

  for (const tool of tools) {
    if (!tool.hasDescription || tool.description.length === 0) {
      diagnostics.push({
        code: 'descriptions/missing',
        severity: 'warning',
        message: `Tool \`${tool.name}\` has no description. The model has only the name and the schema to go on.`,
        tool: tool.name,
      })
      continue
    }
    if (tool.description.length < 20) {
      diagnostics.push({
        code: 'descriptions/very-short',
        severity: 'info',
        message: `Tool \`${tool.name}\` has a ${tool.description.length}-character description, which leaves little to disambiguate it from a neighbour.`,
        tool: tool.name,
        detail: { length: tool.description.length },
      })
    }
  }

  const pairs: OverlapPair[] = []
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const a = prepared[i]!
      const b = prepared[j]!
      const score = diceSimilarity(a.combined, b.combined)
      const shared: Array<{ word: string; df: number }> = []
      for (const word of a.words) {
        if (!b.words.has(word)) continue
        shared.push({ word, df: documentFrequency.get(word) ?? 0 })
      }
      shared.sort((x, y) => x.df - y.df || (x.word < y.word ? -1 : 1))

      pairs.push({
        tools: [a.tool.name, b.tool.name],
        score,
        nameScore: diceSimilarity(a.name, b.name),
        descriptionScore: diceSimilarity(a.description, b.description),
        identicalDescription:
          a.tool.hasDescription &&
          b.tool.hasDescription &&
          a.description.length > 0 &&
          a.description === b.description,
        distinctiveSharedTerms: shared.slice(0, 6).map((item) => item.word),
      })
    }
  }

  pairs.sort((x, y) => y.score - x.score || (x.tools[0] < y.tools[0] ? -1 : 1))

  for (const pair of pairs) {
    if (pair.identicalDescription) {
      diagnostics.push({
        code: 'descriptions/identical',
        severity: 'error',
        message: `\`${pair.tools[0]}\` and \`${pair.tools[1]}\` have byte-identical descriptions. Nothing in the text tells the model which one to pick.`,
        tools: [...pair.tools],
      })
      continue
    }
    if (pair.score >= HIGH_OVERLAP) {
      diagnostics.push({
        code: 'overlap/high',
        severity: 'warning',
        message: `\`${pair.tools[0]}\` and \`${pair.tools[1]}\` overlap at ${pair.score.toFixed(2)} on name-plus-description. Expect the model to confuse them; \`whichtool run\` will tell you whether it actually does.`,
        tools: [...pair.tools],
        detail: { score: Number(pair.score.toFixed(4)) },
      })
    } else if (pair.score >= NOTABLE_OVERLAP) {
      diagnostics.push({
        code: 'overlap/notable',
        severity: 'info',
        message: `\`${pair.tools[0]}\` and \`${pair.tools[1]}\` overlap at ${pair.score.toFixed(2)}.`,
        tools: [...pair.tools],
        detail: { score: Number(pair.score.toFixed(4)) },
      })
    }
  }

  const reported = pairs.slice(0, maxPairs)
  return {
    method: 'sorensen-dice over character trigrams of name-plus-description',
    pairsConsidered: pairs.length,
    pairsReported: reported.length,
    pairs: reported,
    diagnostics,
  }
}
