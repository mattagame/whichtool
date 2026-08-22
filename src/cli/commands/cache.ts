import { WhichtoolError } from '../../core/errors.js'
import { createFileCache, DEFAULT_CACHE_DIR } from '../../runtime/file-cache.js'
import type { Runtime } from '../../runtime/types.js'
import { formatInteger } from '../../core/report/format.js'
import { parseArgs, renderHelp, type FlagSpecs } from '../args.js'

export const CACHE_FLAGS: FlagSpecs = {
  dir: {
    type: 'string',
    description: `Cache directory (default ${DEFAULT_CACHE_DIR})`,
    placeholder: 'path',
  },
  help: { type: 'boolean', alias: 'h', description: 'Show this help' },
}

const USAGE = `whichtool cache <info|clear>

  The trial cache stores what the model answered for a given (provider, model, temperature,
  seed, tool definitions, prompt). A rerun with nothing changed then costs nothing.

  A changed surface produces different keys, so it misses rather than replaying a stale
  answer. There is no invalidation step to forget.
`

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function runCache(runtime: Runtime, argv: readonly string[]): Promise<number> {
  // `--help` sits where a subcommand would, so it has to be recognised there too: the
  // top-level help tells the reader `whichtool <command> --help` works for every command.
  const head = argv[0]
  const askedForHelp = head === '--help' || head === '-h'
  const subcommand = askedForHelp ? undefined : head
  const { flags } = parseArgs(askedForHelp ? argv : argv.slice(1), CACHE_FLAGS)

  if (flags['help'] === true || subcommand === undefined) {
    runtime.writeOut(renderHelp(USAGE, CACHE_FLAGS))
    return 0
  }

  const dir = (flags['dir'] as string | undefined) ?? DEFAULT_CACHE_DIR
  const cache = createFileCache(runtime.resolve(dir), dir)

  switch (subcommand) {
    case 'info': {
      const info = await cache.info()
      runtime.writeOut(
        [
          'whichtool cache',
          `  location  ${info.location}`,
          `  entries   ${formatInteger(info.entries)}`,
          `  size      ${humanBytes(info.bytes)}`,
          '',
          info.entries === 0
            ? '  Empty. A run with --no-cache never writes here.\n'
            : '  Clear it with `whichtool cache clear`.\n',
        ].join('\n'),
      )
      return 0
    }
    case 'clear': {
      const removed = await cache.clear()
      runtime.writeOut(`Removed ${formatInteger(removed)} cached trials from ${dir}.\n`)
      return 0
    }
    default:
      throw new WhichtoolError(
        'cli/unknown-subcommand',
        `Unknown subcommand \`whichtool cache ${subcommand}\`.`,
        'Available: `cache info`, `cache clear`.',
      )
  }
}
