/**
 * Cross-compile standalone executables with `bun build --compile`.
 *
 * Bun cross-compiles, so one machine produces every platform's binary. That matters for the
 * audience this is for: someone who has neither Node nor Bun, wants to check an MCP server
 * once, and should not have to install a runtime to do it.
 *
 * Run with `bun run build:binaries`. Not part of `bun run build`, which produces the npm
 * package and has to stay fast.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const TARGETS = [
  { target: 'bun-linux-x64', output: 'whichtool-linux-x64' },
  { target: 'bun-linux-arm64', output: 'whichtool-linux-arm64' },
  { target: 'bun-darwin-x64', output: 'whichtool-macos-x64' },
  { target: 'bun-darwin-arm64', output: 'whichtool-macos-arm64' },
  { target: 'bun-windows-x64', output: 'whichtool-windows-x64.exe' },
] as const

const OUT_DIR = 'binaries'

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const failures: string[] = []

  for (const { target, output } of TARGETS) {
    const path = join(OUT_DIR, output)
    process.stdout.write(`building ${output} ... `)

    const build = Bun.spawnSync([
      'bun',
      'build',
      './src/cli/main.ts',
      '--compile',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      `--target=${target}`,
      '--minify',
      `--outfile=${path}`,
    ])

    if (build.exitCode === 0) {
      process.stdout.write('ok\n')
      continue
    }
    process.stdout.write('FAILED\n')
    process.stderr.write(new TextDecoder().decode(build.stderr))
    failures.push(target)
  }

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} targets failed: ${failures.join(', ')}\n`)
    process.exit(1)
  }
  process.stdout.write(`\n${TARGETS.length} binaries in ./${OUT_DIR}\n`)
}

await main()
