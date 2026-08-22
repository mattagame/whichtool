import type { InspectReport } from '../inspect.js'
import type { RunReport } from '../run.js'
import type { Diagnostic } from '../types.js'
import { sanitizeTextValue } from './sanitize.js'

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function attributes(pairs: Record<string, string | number>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
    .join(' ')
}

/**
 * A run as JUnit XML.
 *
 * A task fails when the expected tool was the minority pick across its trials, and the
 * failure body carries the prompt, the tally and the confusion — enough for an agent or a
 * human to act without opening anything else.
 */
export function renderRunJUnit(report: RunReport): string {
  report = sanitizeTextValue(report)
  const suiteName = 'whichtool'
  const byTask = new Map<string, typeof report.trials>()
  for (const trial of report.trials) {
    const list = byTask.get(trial.taskId)
    if (list === undefined) byTask.set(trial.taskId, [trial])
    else list.push(trial)
  }

  const promptById = new Map(report.tasks.list.map((task) => [task.id, task.prompt]))
  const cases: string[] = []
  let failures = 0
  let errors = 0

  for (const task of report.tasks.list) {
    const trials = byTask.get(task.id) ?? []
    const scored = trials.filter((trial) => trial.verdict !== 'error')
    const errored = trials.length - scored.length
    const correct = scored.filter(
      (trial) => trial.verdict === 'correct' || trial.verdict === 'correct-abstention',
    ).length
    const multipleCalls = scored.filter((trial) => trial.unexpectedAdditionalCalls).length
    const additionalCallFailures = scored.filter(
      (trial) => trial.verdict === 'unexpected-additional-calls',
    ).length

    const name = escapeXml(task.id)
    const classname = escapeXml(task.expected ?? '(distractor)')
    const time = (trials.reduce((sum, trial) => sum + trial.latencyMs, 0) / 1000).toFixed(3)
    const head = `    <testcase ${attributes({ classname, name, time })}`

    if (scored.length === 0) {
      // Every trial failed at the provider. That is an error, not a wrong answer: the model
      // was never asked.
      errors += 1
      const messages = [...new Set(trials.map((trial) => trial.error?.message ?? 'unknown'))]
      cases.push(
        `${head}>\n      <error ${attributes({ message: `all ${trials.length} trials failed at the provider` })}>${escapeXml(messages.join('\n'))}</error>\n    </testcase>`,
      )
      continue
    }

    if (correct * 2 > scored.length) {
      const notes = [
        multipleCalls === 0 ? '' : `${multipleCalls} trials proposed multiple tool calls`,
        errored === 0
          ? ''
          : `${errored} of ${trials.length} trials failed at the provider and were excluded`,
      ].filter((note) => note !== '')
      const body =
        notes.length === 0
          ? ''
          : `>\n      <system-out>${escapeXml(notes.join('\n'))}</system-out>\n    </testcase>`
      cases.push(body === '' ? `${head} />` : `${head}${body}`)
      continue
    }

    failures += 1
    const tally = new Map<string, number>()
    for (const trial of scored) {
      const firstPick =
        trial.pick ??
        (trial.calls.length > 0 || trial.callCount > 0 ? '(malformed call)' : '(no call)')
      const key =
        trial.verdict === 'unexpected-additional-calls'
          ? `${firstPick} + additional calls`
          : firstPick
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }
    const picks = [...tally]
      .sort((a, b) => b[1] - a[1])
      .map(([pick, count]) => `${pick} x${count}`)
      .join(', ')

    const detail = [
      `prompt: ${promptById.get(task.id) ?? ''}`,
      `expected: ${task.expected ?? 'no tool call'}`,
      `picked: ${picks}`,
      `correct in ${correct} of ${scored.length} trials`,
      multipleCalls === 0 ? '' : `${multipleCalls} trials proposed multiple tool calls`,
      errored === 0 ? '' : `${errored} trials failed at the provider and were excluded`,
    ]
      .filter((line) => line !== '')
      .join('\n')

    cases.push(
      `${head}>\n      <failure ${attributes({
        message:
          additionalCallFailures === 0
            ? `expected ${task.expected ?? 'no tool call'}, got ${picks}`
            : `expected one call to ${task.expected ?? 'no tool call'}, got multiple calls in ${additionalCallFailures} of ${scored.length} trials`,
        type:
          task.expected === null
            ? 'over-trigger'
            : additionalCallFailures > 0
              ? 'multiple-calls'
              : 'wrong-tool',
      })}>${escapeXml(detail)}</failure>\n    </testcase>`,
    )
  }

  // Thresholds get their own suite: a green task list with a blown budget must not read as
  // an all-clear.
  const thresholdCases = report.thresholds.map((check) => {
    const head = `    <testcase ${attributes({ classname: 'threshold', name: check.name })}`
    if (check.ok) return `${head} />`
    failures += 1
    return `${head}>\n      <failure ${attributes({
      message: `${check.name}: ${check.actual} against a limit of ${check.limit}`,
      type: 'threshold',
    })}>${escapeXml(`actual ${check.actual}, limit ${check.limit}`)}</failure>\n    </testcase>`
  })

  const executionCase = report.execution.ok
    ? `    <testcase ${attributes({ classname: 'execution', name: 'run health' })} />`
    : `    <testcase ${attributes({ classname: 'execution', name: 'run health' })}>
      <error ${attributes({
        message: `${report.execution.scored} of ${report.execution.planned} trials scored`,
        type: 'execution',
      })}>${escapeXml(`unavailable rate ${report.execution.errorRate.value}; maximum ${report.execution.maxErrorRate}; minimum scored ${report.execution.minScored}`)}</error>
    </testcase>`

  // Execution and threshold failures already have dedicated suites. This case covers the
  // remaining machine-failing verdict: an error diagnostic from surface/run analysis.
  const uncoveredVerdictFailure = !report.ok && report.execution.ok && report.thresholdsOk
  const verdictDiagnostics = report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  )
  const verdictFailures = uncoveredVerdictFailure ? 1 : 0
  if (uncoveredVerdictFailure) failures += 1
  const verdictSuite = uncoveredVerdictFailure
    ? `  <testsuite ${attributes({ name: `${suiteName}.diagnostics`, tests: 1, failures: 1, errors: 0, time: '0' })}>
    <testcase ${attributes({ classname: 'diagnostics', name: 'run verdict' })}>
      <failure ${attributes({ message: `${verdictDiagnostics.length} error diagnostic(s)`, type: 'diagnostic' })}>${escapeXml(verdictDiagnostics.map((diagnostic) => `[${diagnostic.code}] ${diagnostic.message}`).join('\n'))}</failure>
    </testcase>
  </testsuite>
`
    : ''

  const executionErrors = report.execution.ok ? 0 : 1
  const thresholdFailures = thresholdCases.filter((entry) => entry.includes('<failure')).length
  const taskFailures = failures - thresholdFailures - verdictFailures
  const total = cases.length + thresholdCases.length + 1 + verdictFailures
  const seconds = (report.durationMs / 1000).toFixed(3)
  const properties = [
    ['provider', report.reproducibility.provider],
    ['model', report.reproducibility.model],
    ['surfaceHash', report.reproducibility.surfaceHash],
    ['repeat', String(report.reproducibility.repeat)],
    ['temperature', String(report.reproducibility.temperature)],
    ['permuted', String(report.reproducibility.permuted)],
    ['accuracy', String(report.metrics.accuracy.value)],
    ['accuracyTrials', String(report.metrics.accuracy.denominator)],
    ['overTrigger', String(report.metrics.overTrigger.value)],
    ['multiCallRate', String(report.metrics.multiCallRate.value)],
    ['multiCallTrials', String(report.metrics.multiCallRate.denominator)],
  ]
    .map(
      ([name, value]) =>
        `      <property ${attributes({ name: name as string, value: value as string })} />`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites ${attributes({ name: suiteName, tests: total, failures, errors: errors + executionErrors, time: seconds })}>
  <testsuite ${attributes({ name: `${suiteName}.tool-selection`, tests: cases.length, failures: taskFailures, errors, time: seconds })}>
    <properties>
${properties}
    </properties>
${cases.join('\n')}
  </testsuite>
  <testsuite ${attributes({ name: `${suiteName}.thresholds`, tests: thresholdCases.length, failures: thresholdFailures, errors: 0, time: '0' })}>
${thresholdCases.join('\n')}
  </testsuite>
${verdictSuite}  <testsuite ${attributes({ name: `${suiteName}.execution`, tests: 1, failures: 0, errors: executionErrors, time: '0' })}>
${executionCase}
  </testsuite>
</testsuites>
`
}

/**
 * An inspection as JUnit XML.
 *
 * One test case per diagnostic code per subject, so a surface that grows a second identical
 * description shows up as a new failing test rather than as a longer log nobody reads.
 */
export function renderInspectJUnit(report: InspectReport): string {
  report = sanitizeTextValue(report)
  const suiteName = 'whichtool'

  const caseFor = (diagnostic: Diagnostic, index: number): string => {
    const subject = diagnostic.tool ?? diagnostic.tools?.join(', ') ?? 'surface'
    const head = `    <testcase ${attributes({
      classname: diagnostic.code,
      name: `${subject} #${index}`,
      time: '0',
    })}`
    if (diagnostic.severity !== 'error') {
      return `${head}>\n      <system-out>${escapeXml(diagnostic.message)}</system-out>\n    </testcase>`
    }
    return `${head}>\n      <failure ${attributes({
      message: diagnostic.message.slice(0, 300),
      type: diagnostic.severity,
    })}>${escapeXml(diagnostic.message)}</failure>\n    </testcase>`
  }

  const cases = report.diagnostics.map(caseFor)
  const failures = report.diagnostics.filter((d) => d.severity === 'error').length

  // A clean surface still needs one passing case: an empty suite is reported as "no tests
  // ran", which reads as a broken pipeline rather than a good result.
  if (cases.length === 0) {
    cases.push(
      `    <testcase ${attributes({ classname: 'surface', name: 'no findings', time: '0' })} />`,
    )
  }

  const properties = [
    ['surfaceHash', report.surface.hash],
    ['toolCount', String(report.surface.toolCount)],
    ['contextTokens', String(report.tokens.total)],
    ['tokenizer', report.tokens.tokenizer.id],
    ['tokenizerExact', String(report.tokens.tokenizer.exact)],
  ]
    .map(
      ([name, value]) =>
        `      <property ${attributes({ name: name as string, value: value as string })} />`,
    )
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites ${attributes({ name: suiteName, tests: cases.length, failures, errors: 0, time: '0' })}>
  <testsuite ${attributes({ name: `${suiteName}.surface`, tests: cases.length, failures, errors: 0, time: '0' })}>
    <properties>
${properties}
    </properties>
${cases.join('\n')}
  </testsuite>
</testsuites>
`
}
