import type { TargetSpec } from './core/transport/types.js'

export type ReportFormat = 'terminal' | 'json' | 'markdown' | 'html' | 'junit' | 'badge'

export interface ProviderConfig {
  name: string
  model?: string

  baseUrl?: string
}

export interface TrialsConfig {
  repeat?: number
  permute?: boolean
  temperature?: number
  concurrency?: number
  seed?: number
  /** Provider-side reasoning setting; recorded because it changes the measured subject. */
  reasoningEffort?: string
}

export interface ThresholdsConfig {
  minAccuracy?: number
  maxOverTrigger?: number
  maxContextTokens?: number
  /** Maximum share of planned trials that may fail at the provider (default 0.1). */
  maxErrorRate?: number
  /** Minimum number of successfully scored trials required for a valid run (default 1). */
  minScored?: number
}

export interface ReportConfig {
  formats?: ReportFormat[]

  out?: string
}

export interface WhichtoolConfig {
  target?: TargetSpec
  tasks?: string
  provider?: ProviderConfig
  trials?: TrialsConfig
  thresholds?: ThresholdsConfig
  report?: ReportConfig
}

export function defineConfig(config: WhichtoolConfig): WhichtoolConfig {
  return config
}

export type { TargetSpec }
