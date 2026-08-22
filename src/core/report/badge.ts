import type { Proportion } from '../eval/metrics.js'
import type { InspectReport } from '../inspect.js'
import type { RunReport } from '../run.js'
import type { JsonObject } from '../types.js'

export interface Badge extends JsonObject {
  schemaVersion: 1
  label: string
  message: string
  color: string
}

function colorFor(value: number, thresholds: readonly [number, number, number, number]): string {
  if (Number.isNaN(value)) return 'lightgrey'
  if (value >= thresholds[3]) return 'brightgreen'
  if (value >= thresholds[2]) return 'green'
  if (value >= thresholds[1]) return 'yellow'
  if (value >= thresholds[0]) return 'orange'
  return 'red'
}

function withDenominator(value: Proportion): string {
  if (value.value === null) return 'not measured'
  return `${Math.round(value.value * 100)}% of ${value.denominator}`
}

export interface BadgeOptions {
  label?: string
}

function failedRunMessage(report: RunReport): string | null {
  if (report.ok) return null
  if (!report.execution.ok) {
    return `invalid run (${report.execution.scored}/${report.execution.planned} scored)`
  }
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
  return `failing verdict (${errors} error${errors === 1 ? '' : 's'})`
}

/** Accuracy badge for a run. Grey when nothing was measured, never a reassuring green. */
export function badgeForRun(report: RunReport, options: BadgeOptions = {}): Badge {
  const failure = failedRunMessage(report)
  if (failure !== null) {
    return {
      schemaVersion: 1,
      label: options.label ?? 'tool selection',
      message: failure,
      color: 'red',
    }
  }
  const accuracy = report.metrics.accuracy
  return {
    schemaVersion: 1,
    label: options.label ?? 'tool selection',
    message: withDenominator(accuracy),
    color: accuracy.value === null ? 'lightgrey' : colorFor(accuracy.value, [0.5, 0.75, 0.9, 0.97]),
  }
}

/** Over-trigger badge: the metric that moves the wrong way when accuracy is chased. */
export function badgeForOverTrigger(report: RunReport, options: BadgeOptions = {}): Badge {
  const failure = failedRunMessage(report)
  if (failure !== null) {
    return {
      schemaVersion: 1,
      label: options.label ?? 'over-trigger',
      message: failure,
      color: 'red',
    }
  }
  const rate = report.metrics.overTrigger
  return {
    schemaVersion: 1,
    label: options.label ?? 'over-trigger',
    message: withDenominator(rate),
    // Inverted: a low rate is the good outcome here.
    color: rate.value === null ? 'lightgrey' : colorFor(1 - rate.value, [0.5, 0.75, 0.9, 0.97]),
  }
}

/** Context-cost badge from an inspection. No model needed to produce it. */
export function badgeForInspect(report: InspectReport, options: BadgeOptions = {}): Badge {
  const tokens = report.tokens.total
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
  return {
    schemaVersion: 1,
    label: options.label ?? 'tool surface',
    message: `${report.surface.toolCount} tool${report.surface.toolCount === 1 ? '' : 's'}, ~${tokens} tokens${errors > 0 ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}`,
    color: errors > 0 ? 'red' : tokens > 8000 ? 'orange' : tokens > 4000 ? 'yellow' : 'green',
  }
}

export function renderBadgeJson(badge: Badge): string {
  return `${JSON.stringify(badge, null, 2)}\n`
}
