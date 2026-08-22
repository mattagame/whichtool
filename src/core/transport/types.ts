import type { Diagnostic, JsonObject, RawTool } from '../types.js'

export type TargetSpec =
  | { transport: 'snapshot'; path: string }
  | { transport: 'http'; url: string; headers?: Record<string, string> }
  | {
      transport: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
    }
  | { transport: 'legacy-sse'; url: string; headers?: Record<string, string> }

export type TransportKind = TargetSpec['transport']

export interface ListToolsResult {
  tools: RawTool[]

  diagnostics: Diagnostic[]

  meta?: JsonObject
}

export interface Transport {
  readonly kind: TransportKind

  readonly ref: string
  listTools(): Promise<ListToolsResult>

  close?(): Promise<void>
}

export interface TransportDeps {
  readTextFile(path: string): Promise<string>
  fetch?: typeof fetch
  spawn?(spec: SpawnSpec): Promise<McpProcess>
}

export interface SpawnSpec {
  command: string
  args: string[]
  cwd?: string | undefined
  env?: Record<string, string> | undefined
}

export interface McpProcess {
  writeLine(line: string): Promise<void>

  nextLine(): Promise<string | null>

  stderrText(): string

  close(): Promise<void>
}
