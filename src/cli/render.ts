import { badgeForInspect, badgeForRun, renderBadgeJson } from '../core/report/badge.js'
import { renderRunHtml } from '../core/report/html.js'
import { renderInspectJUnit, renderRunJUnit } from '../core/report/junit.js'
import { renderInspectMarkdown, renderRunMarkdown } from '../core/report/markdown.js'
import { renderRunTerminal } from '../core/report/run-terminal.js'
import { renderInspectTerminal } from '../core/report/terminal.js'
import { WhichtoolError } from '../core/errors.js'
import { shouldUseColor } from '../core/report/format.js'
import type { InspectReport } from '../core/inspect.js'
import type { RunReport } from '../core/run.js'
import type { Runtime } from '../runtime/types.js'

export const INSPECT_FORMATS = ['terminal', 'json', 'markdown', 'junit', 'badge'] as const
export const RUN_FORMATS = ['terminal', 'json', 'markdown', 'html', 'junit', 'badge'] as const

export const FORMAT_EXTENSION: Record<string, string> = {
  terminal: 'txt',
  json: 'json',
  markdown: 'md',
  html: 'html',
  junit: 'xml',
  badge: 'badge.json',
}

export type InspectFormat = (typeof INSPECT_FORMATS)[number]
export type RunFormat = (typeof RUN_FORMATS)[number]

export interface RenderOptions {
  color: boolean
  width: number
}

function reject(command: string, format: string, available: readonly string[]): never {
  throw new WhichtoolError(
    'cli/unsupported-format',
    `\`--format ${format}\` is not available for \`${command}\`.`,
    `Available: ${available.join(', ')}.`,
  )
}

export function assertInspectFormat(format: string): InspectFormat {
  if ((INSPECT_FORMATS as readonly string[]).includes(format)) return format as InspectFormat
  return reject('inspect', format, INSPECT_FORMATS)
}

export function assertRunFormat(format: string): RunFormat {
  if ((RUN_FORMATS as readonly string[]).includes(format)) return format as RunFormat
  return reject('run', format, RUN_FORMATS)
}

/**
 * The JSON reporters.
 *
 * SPEC §5.8: this is the contract downstream tools read, so it is versioned via
 * `schemaVersion` and treated as a public API. It deliberately carries no timestamp, no
 * duration and no absolute path, which means two inspections of the same surface produce
 * byte-identical output — that is what makes it usable in a golden test and in a CI diff.
 */
function json(report: unknown): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

export function renderInspect(
  report: InspectReport,
  format: InspectFormat,
  options: RenderOptions,
): string {
  switch (format) {
    case 'json':
      return json(report)
    case 'markdown':
      return renderInspectMarkdown(report)
    case 'junit':
      return renderInspectJUnit(report)
    case 'badge':
      return renderBadgeJson(badgeForInspect(report))
    case 'terminal':
      return `${renderInspectTerminal(report, options)}\n`
  }
}

export function renderRun(report: RunReport, format: RunFormat, options: RenderOptions): string {
  switch (format) {
    case 'json':
      return json(report)
    case 'markdown':
      return renderRunMarkdown(report)
    case 'html':
      return renderRunHtml(report)
    case 'junit':
      return renderRunJUnit(report)
    case 'badge':
      return renderBadgeJson(badgeForRun(report))
    case 'terminal':
      return `${renderRunTerminal(report, options)}\n`
  }
}

/** Formats that are files rather than terminal output, so colour never applies. */
export function isFileFormat(format: string): boolean {
  return format !== 'terminal'
}

/**
 * Whether to colour this output.
 *
 * An explicit `--color`/`--no-color` wins; otherwise `NO_COLOR`, `FORCE_COLOR` and whether
 * stdout is a terminal decide. Anything written to a file, or rendered in a format that is
 * not terminal text, is never coloured.
 */
export function decideColor(
  runtime: Runtime,
  options: { format?: string; outPath?: string | undefined; colorFlag?: boolean | undefined } = {},
): boolean {
  if (options.outPath !== undefined) return false
  if (options.format !== undefined && isFileFormat(options.format)) return false
  return (
    options.colorFlag ??
    shouldUseColor({
      noColor: runtime.env('NO_COLOR'),
      forceColor: runtime.env('FORCE_COLOR'),
      isTTY: runtime.isStdoutTTY(),
    })
  )
}

/**
 * Write the rendered report, or print it.
 *
 * The confirmation echoes the path the user typed rather than the resolved one: this line
 * gets pasted into issues, and an absolute path in it exposes a home directory.
 */
export async function emit(
  runtime: Runtime,
  rendered: string,
  outPath: string | undefined,
  label: string,
): Promise<void> {
  if (outPath === undefined) {
    runtime.writeOut(rendered)
    return
  }
  await runtime.writeTextFile(runtime.resolve(outPath), rendered)
  runtime.writeErr(`Wrote ${label} to ${outPath}\n`)
}
