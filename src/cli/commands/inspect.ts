import { WhichtoolError } from '../../core/errors.js'
import { buildInspectReport, type InspectOptions } from '../../core/inspect.js'
import { surfaceFromListing } from '../../core/surface/fetch.js'
import type { Runtime } from '../../runtime/types.js'
import { parseArgs, renderHelp, type FlagSpecs } from '../args.js'
import { loadConfig } from '../config-loader.js'
import {
  assertInspectFormat,
  decideColor,
  FORMAT_EXTENSION,
  INSPECT_FORMATS,
  renderInspect,
} from '../render.js'
import { openTarget } from '../target.js'

export const INSPECT_FLAGS: FlagSpecs = {
  transport: {
    type: 'string',
    description: 'snapshot | http | stdio | legacy-sse (inferred from the target when omitted)',
    placeholder: 'name',
  },
  format: { type: 'string', description: INSPECT_FORMATS.join(' | '), placeholder: 'name' },
  out: {
    type: 'string',
    description: 'Write the report to this file instead of stdout',
    placeholder: 'file',
  },
  'max-context-tokens': {
    type: 'number',
    description: 'Exit 1 when the surface costs more than this',
    placeholder: 'n',
  },
  provider: {
    type: 'string',
    description: 'Provider whose tokenizer to approximate (recorded in the report either way)',
    placeholder: 'name',
  },
  config: { type: 'string', description: 'Path to a whichtool config file', placeholder: 'file' },
  'save-snapshot': {
    type: 'string',
    description: 'Write the served tools/list here, so later runs need no live server',
    placeholder: 'file',
  },
  color: { type: 'boolean', description: 'Force colour on; --no-color forces it off' },
  help: { type: 'boolean', alias: 'h', description: 'Show this help' },
}

const USAGE = `whichtool inspect <target>

  Read a server's tool surface and report what it costs and where it is ambiguous.
  Calls no model, needs no API key, and never executes a tool.

  <target>  a captured tools/list (./tools.json), or a URL, or --transport stdio "<command>"
`

export async function runInspect(runtime: Runtime, argv: readonly string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, INSPECT_FLAGS)

  if (flags['help'] === true) {
    runtime.writeOut(renderHelp(USAGE, INSPECT_FLAGS))
    return 0
  }

  if (positionals.length > 1) {
    throw new WhichtoolError(
      'cli/too-many-targets',
      `\`inspect\` takes one target, got ${positionals.length}: ${positionals.join(', ')}.`,
    )
  }

  const format = assertInspectFormat((flags['format'] as string | undefined) ?? 'terminal')

  const config = await loadConfig(runtime, flags['config'] as string | undefined)
  const transport = await openTarget(runtime, positionals[0], {
    transport: flags['transport'] as string | undefined,
    config,
  })

  try {
    const providerFlag = flags['provider'] as string | undefined

    // One listing, used for both the report and the snapshot. Asking twice would break the
    // one-call property `tests/non-execution.test.ts` guards, and could produce a snapshot
    // that disagrees with the report printed next to it.
    const listed = await transport.listTools()
    const surface = await surfaceFromListing(listed, transport.kind, transport.ref, {
      provider: providerFlag ?? config.provider?.name ?? null,
    })

    // Saved before normalization: the file has to be what the server actually served, so it
    // stays readable by anything else and keeps working when the canonical form changes.
    const snapshotPath = flags['save-snapshot'] as string | undefined
    if (snapshotPath !== undefined) {
      await runtime.writeTextFile(
        runtime.resolve(snapshotPath),
        `${JSON.stringify({ tools: listed.tools }, null, 2)}\n`,
      )
      runtime.writeErr(`Saved ${listed.tools.length} tools to ${snapshotPath}\n`)
    }

    const options: InspectOptions = {}
    const maxContextTokens =
      (flags['max-context-tokens'] as number | undefined) ?? config.thresholds?.maxContextTokens
    if (maxContextTokens !== undefined) options.maxContextTokens = maxContextTokens

    const report = buildInspectReport(surface, options)
    const outPath = flags['out'] as string | undefined

    // An explicit --color/--no-color wins; otherwise NO_COLOR, FORCE_COLOR and TTY
    // detection decide. A report written to a file, or in any non-terminal format, is
    // never coloured.
    const color = decideColor(runtime, {
      format,
      outPath,
      colorFlag: flags['color'] as boolean | undefined,
    })

    const rendered = renderInspect(report, format, {
      color,
      width: runtime.terminalWidth() ?? 88,
    })

    if (outPath === undefined) {
      runtime.writeOut(rendered)
    } else {
      // The path as typed, never the resolved one: this line gets pasted, and an absolute
      // path in it exposes a home directory.
      await runtime.writeTextFile(runtime.resolve(outPath), rendered)
      runtime.writeErr(`Wrote ${format} report to ${outPath}\n`)
    }

    // Same multi-format pass as `run`, so a config that asks for json plus junit gets both
    // from the free command too.
    const extraFormats = config.report?.formats ?? []
    const reportBase = config.report?.out
    if (extraFormats.length > 0 && reportBase !== undefined) {
      for (const extra of extraFormats) {
        if (extra === 'terminal' && outPath === undefined) continue
        if (extra === 'html') continue // an inspection has no confusion matrix to navigate
        const target = `${reportBase}.${FORMAT_EXTENSION[extra] ?? extra}`
        await runtime.writeTextFile(
          runtime.resolve(target),
          renderInspect(report, assertInspectFormat(extra), { color: false, width: 88 }),
        )
        runtime.writeErr(`Wrote ${extra} report to ${target}\n`)
      }
    }

    return report.ok ? 0 : 1
  } finally {
    await transport.close?.()
  }
}
