import type { McpProcess, SpawnSpec } from '../core/transport/types.js'

export interface Runtime {
  readonly name: 'bun' | 'node'
  /** Aborted when the human running the CLI asks the current command to stop. */
  readonly signal?: AbortSignal | undefined
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, content: string): Promise<void>
  fileExists(path: string): Promise<boolean>
  fileSize(path: string): Promise<number>
  env(name: string): string | undefined
  cwd(): string

  resolve(...segments: string[]): string
  /** Resolve symlinks/junctions and return the canonical filesystem path. */
  realpath(path: string): Promise<string>
  isStdoutTTY(): boolean

  terminalWidth(): number | undefined
  writeOut(text: string): void
  writeErr(text: string): void

  importModule(absolutePath: string): Promise<unknown>

  spawnProcess(spec: SpawnSpec): Promise<McpProcess>

  readStdinLines(): AsyncIterable<string>
}
