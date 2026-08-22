import { MULTI_CALL, NONE, PHANTOM, type Proportion } from '../eval/metrics.js'
import type { RunReport } from '../run.js'
import { shortHash } from '../surface/hash.js'
import { WHICHTOOL_VERSION } from '../../version.js'
import { formatPercent } from './format.js'
import { sanitizeTextValue } from './sanitize.js'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function rate(value: Proportion): string {
  if (value.value === null) return 'n/a'
  const percent = `${Math.round(value.value * 100)}%`
  const interval =
    value.ci95 === null
      ? ''
      : ` <span class="ci">[${Math.round(value.ci95[0] * 100)}–${Math.round(value.ci95[1] * 100)}%]</span>`
  return `${percent}${interval} <span class="frac">${value.numerator}/${value.denominator}</span>`
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #16181d; --muted: #5c6370; --line: #e2e5ea;
  --panel: #f7f8fa; --good: #1a7f37; --bad: #b42318; --warn: #9a6700; --accent: #1f6feb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --line: #262c36;
    --panel: #161b22; --good: #3fb950; --bad: #f85149; --warn: #d29922; --accent: #58a6ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 62rem; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2.25rem 0 .75rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
.sub { color: var(--muted); font-size: .85rem; margin: 0 0 1.5rem; }
.sub code { background: var(--panel); padding: .1rem .35rem; border-radius: 4px; }
.verdict { padding: .7rem 1rem; border-radius: 8px; font-weight: 600; margin-bottom: 1.5rem; }
.verdict.pass { background: color-mix(in srgb, var(--good) 14%, transparent); color: var(--good); }
.verdict.fail { background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); }
.verdict.none { background: var(--panel); color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .75rem; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: .8rem .9rem; }
.card .label { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.card .value { font-size: 1.25rem; font-weight: 600; margin-top: .2rem; }
.ci { color: var(--muted); font-weight: 400; font-size: .8em; }
.frac { color: var(--muted); font-weight: 400; font-size: .8em; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .88rem; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .03em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
.matrix td.cell { cursor: pointer; text-align: right; font-variant-numeric: tabular-nums; }
.matrix td.cell:hover, .matrix td.cell:focus-visible { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.matrix td.hit { color: var(--good); font-weight: 700; }
.matrix td.miss { color: var(--bad); font-weight: 700; }
.matrix td.zero { color: var(--muted); }
.matrix td.selected { outline: 2px solid var(--accent); outline-offset: -2px; }
.trials { margin-top: 1rem; }
.trial { border: 1px solid var(--line); border-radius: 8px; padding: .7rem .9rem; margin-bottom: .5rem; background: var(--panel); }
.trial .meta { color: var(--muted); font-size: .78rem; margin-bottom: .3rem; }
.trial .prompt { font-style: italic; }
.pill { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-size: .72rem; font-weight: 600; }
.pill.correct { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
.pill.wrong { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
.pill.other { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.finding { display: flex; gap: .6rem; padding: .45rem 0; border-bottom: 1px solid var(--line); font-size: .88rem; }
.finding .sev { font-weight: 700; flex: 0 0 4.5rem; }
.finding .sev.error { color: var(--bad); } .finding .sev.warning { color: var(--warn); } .finding .sev.info { color: var(--muted); }
footer { margin-top: 3rem; color: var(--muted); font-size: .8rem; border-top: 1px solid var(--line); padding-top: 1rem; }
.hint { color: var(--muted); font-size: .82rem; margin: .4rem 0 0; }
`

const SCRIPT = `
const data = JSON.parse(document.getElementById("whichtool-data").textContent);
const box = document.getElementById("trials");
let selected = null;



function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pill(verdict) {
  const kind = verdict === "correct" || verdict === "correct-abstention" ? "correct"
    : verdict === "error" ? "other"
    : verdict === "abstained" ? "other" : "wrong";
  return '<span class="pill ' + kind + '">' + verdict + "</span>";
}

function show(expected, picked, cellEl) {
  document.querySelectorAll(".matrix td.selected").forEach((el) => {
    el.classList.remove("selected");
    el.setAttribute("aria-pressed", "false");
  });
  if (selected === expected + "\\u0000" + picked) {
    selected = null;
    box.innerHTML = "";
    return;
  }
  selected = expected + "\\u0000" + picked;
  cellEl.classList.add("selected");
  cellEl.setAttribute("aria-pressed", "true");

  const rows = data.trials.filter((t) => (t.expected ?? "(none)") === expected && t.picked === picked);
  box.innerHTML =
    "<h3>" + rows.length + " trial" + (rows.length === 1 ? "" : "s") +
    ": expected <code>" + esc(expected) + "</code>, picked <code>" + esc(picked) + "</code></h3>" +
    rows.map((t) =>
      '<div class="trial"><div class="meta">' + esc(t.taskId) + " &middot; trial " + t.trialIndex +
      " &middot; " + pill(t.verdict) + " &middot; expected tool at position " +
      (t.expectedPosition < 0 ? "n/a" : t.expectedPosition) +
      "</div><div class=\\"prompt\\">" + esc(t.prompt) + "</div>" +
      (t.args ? "<div class=\\"meta\\">arguments: <code>" + esc(t.args) + "</code></div>" : "") +
      (t.calls.length > 1 ? "<div class=\\"meta\\">all proposed calls: <code>" + esc(JSON.stringify(t.calls)) + "</code></div>" : "") +
      (t.reply ? "<div class=\\"meta\\">replied: " + esc(t.reply) + "</div>" : "") +
      "</div>").join("");
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

document.querySelectorAll(".matrix td.cell").forEach((el) => {
  el.addEventListener("click", () => show(el.dataset.expected, el.dataset.picked, el));
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    show(el.dataset.expected, el.dataset.picked, el);
  });
});
`

export function renderRunHtml(report: RunReport): string {
  report = sanitizeTextValue(report)
  const metrics = report.metrics
  const repro = report.reproducibility

  const expectedRows = Object.keys(metrics.confusionMatrix).sort()
  const pickedColumns = [
    ...new Set(Object.values(metrics.confusionMatrix).flatMap((row) => Object.keys(row))),
  ].sort((a, b) => {
    // Keep the two synthetic columns at the end, where they read as annotations.
    const rank = (name: string): number =>
      name === NONE ? 1 : name === PHANTOM ? 2 : name === MULTI_CALL ? 3 : 0
    return rank(a) - rank(b) || (a < b ? -1 : 1)
  })

  const promptById = new Map(report.tasks.list.map((task) => [task.id, task.prompt]))
  const onSurface = new Set(metrics.byTool.map((tool) => tool.tool))
  const trialData = report.trials.map((trial) => ({
    taskId: trial.taskId,
    trialIndex: trial.trialIndex,
    expected: trial.expected ?? NONE,
    picked: trial.unexpectedAdditionalCalls
      ? MULTI_CALL
      : trial.pick === null
        ? trial.calls.length > 0 || trial.callCount > 0
          ? PHANTOM
          : NONE
        : onSurface.has(trial.pick)
          ? trial.pick
          : PHANTOM,
    verdict: trial.verdict,
    expectedPosition: trial.expectedPosition,
    prompt: promptById.get(trial.taskId) ?? trial.taskId,
    // The assistant's own words, when it answered instead of calling. That is where a
    // request for clarification shows up, and it explains an abstention better than a count.
    reply: trial.text.slice(0, 400),
    args: trial.arguments === null ? '' : JSON.stringify(trial.arguments),
    calls: trial.calls,
  }))
  const diagnosticErrors = report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  ).length

  const verdictClass = !report.ok ? 'fail' : report.thresholds.length === 0 ? 'none' : 'pass'
  const verdictText = !report.execution.ok
    ? `Invalid run: ${report.execution.scored} of ${report.execution.planned} trials were scored; ${formatPercent(report.execution.errorRate.value)} unavailable (maximum ${formatPercent(report.execution.maxErrorRate)}).`
    : !report.thresholdsOk
      ? `${report.thresholds.filter((check) => !check.ok).length} threshold(s) violated.`
      : !report.ok
        ? `Run failed with ${diagnosticErrors} error diagnostic(s).`
        : report.thresholds.length === 0
          ? 'No thresholds configured; no error diagnostics.'
          : 'All thresholds met.'

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>whichtool run — ${escapeHtml(repro.model)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>whichtool run</h1>
  <p class="sub">
    <code>${escapeHtml(repro.provider)}</code> · <code>${escapeHtml(repro.model)}</code> ·
    surface <code>${escapeHtml(shortHash(repro.surfaceHash))}</code> ·
    ${metrics.trials.planned} trials (${report.tasks.selected} tasks × ${repro.repeat}) ·
    temperature ${repro.temperature} · seed ${repro.seed} ·
    ${repro.permuted ? 'tool order permuted' : '<strong>tool order NOT permuted</strong>'}
  </p>

  <div class="verdict ${verdictClass}">${escapeHtml(verdictText)}</div>

  <div class="cards">
    <div class="card"><div class="label">single-call accuracy</div><div class="value">${rate(metrics.accuracy)}</div></div>
    <div class="card"><div class="label">abstention</div><div class="value">${rate(metrics.abstention)}</div></div>
    <div class="card"><div class="label">over-trigger</div><div class="value">${rate(metrics.overTrigger)}</div></div>
    <div class="card"><div class="label">phantom tools</div><div class="value">${rate(metrics.phantom)}</div></div>
    <div class="card"><div class="label">multiple calls</div><div class="value">${rate(metrics.multiCallRate)}</div></div>
    <div class="card"><div class="label">failed trials</div><div class="value">${metrics.trials.errored}<span class="frac">/${metrics.trials.planned}</span></div></div>
  </div>
  <p class="hint">Abstention and over-trigger are shown together because improving one worsens the other.
  A correct first choice followed by more calls is not counted as correct. Failed trials are
  excluded from every rate above, never counted as the model choosing nothing.</p>

  <h2>Confusion matrix</h2>
  <div class="scroll">
  <table class="matrix">
    <thead><tr><th>expected \\ picked</th>${pickedColumns
      .map(
        (name) =>
          `<th class="num">${escapeHtml(name === NONE ? 'no call' : name === PHANTOM ? 'phantom' : name)}</th>`,
      )
      .join('')}</tr></thead>
    <tbody>
      ${expectedRows
        .map((expected) => {
          const row = metrics.confusionMatrix[expected] ?? {}
          const cells = pickedColumns
            .map((picked) => {
              const count = row[picked] ?? 0
              const kind = count === 0 ? 'zero' : picked === expected ? 'hit' : 'miss'
              const label = `Expected ${expected === NONE ? 'no call' : expected}; picked ${picked === NONE ? 'no call' : picked === PHANTOM ? 'a phantom tool' : picked}: ${count} trial${count === 1 ? '' : 's'}`
              return `<td class="cell ${kind}" role="button" tabindex="0" aria-controls="trials" aria-pressed="false" aria-label="${escapeHtml(label)}" data-expected="${escapeHtml(expected)}" data-picked="${escapeHtml(picked)}">${count === 0 ? '·' : count}</td>`
            })
            .join('')
          return `<tr><th><code>${escapeHtml(expected === NONE ? '(distractor)' : expected)}</code></th>${cells}</tr>`
        })
        .join('\n      ')}
    </tbody>
  </table>
  </div>
  <p class="hint">Select any cell to read the trials behind it.</p>
  <div class="trials" id="trials" aria-live="polite"></div>

  <h2>Confusion pairs</h2>
  ${
    metrics.confusionPairs.length === 0
      ? '<p class="hint">No tool was ever picked when a different one was expected.</p>'
      : `<div class="scroll"><table>
    <thead><tr><th class="num">swaps</th><th>pair</th><th>rate</th><th>direction</th></tr></thead>
    <tbody>${metrics.confusionPairs
      .map(
        (pair) =>
          `<tr><td class="num">${pair.swaps}</td><td><code>${escapeHtml(pair.tools[0])}</code> ↔ <code>${escapeHtml(pair.tools[1])}</code></td><td>${rate(pair.rate)}</td><td><code>${escapeHtml(pair.tools[0])}</code> ← ${pair.bChosenWhenAExpected}, <code>${escapeHtml(pair.tools[1])}</code> ← ${pair.aChosenWhenBExpected}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
  }

  <h2>Per tool</h2>
  <div class="scroll">
  <table>
    <thead><tr><th>tool</th><th>single-call accuracy</th><th>confused with</th><th>arguments valid</th><th class="num">tokens</th></tr></thead>
    <tbody>${metrics.byTool
      .map(
        (tool) =>
          `<tr><td><code>${escapeHtml(tool.tool)}</code></td><td>${tool.accuracy.denominator === 0 ? '<span class="ci">no tasks</span>' : rate(tool.accuracy)}</td><td>${tool.confusedWith
            .map((item) => `<code>${escapeHtml(item.tool)}</code> ×${item.count}`)
            .join(
              ', ',
            )}</td><td>${tool.argumentAccuracy.denominator === 0 ? '—' : rate(tool.argumentAccuracy)}</td><td class="num">~${tool.contextTokens}</td></tr>`,
      )
      .join('')}</tbody>
  </table>
  </div>

  <h2>Findings</h2>
  ${
    report.diagnostics.length === 0
      ? '<p class="hint">Nothing to report.</p>'
      : report.diagnostics
          .map(
            (diagnostic) =>
              `<div class="finding"><div class="sev ${diagnostic.severity}">${diagnostic.severity}</div><div><code>${escapeHtml(diagnostic.code)}</code> — ${escapeHtml(diagnostic.message)}</div></div>`,
          )
          .join('')
  }

  <h2>Reproducibility</h2>
  <div class="scroll">
  <table>
    <tbody>
      <tr><th>whichtool</th><td>${escapeHtml(repro.whichtoolVersion)}</td></tr>
      <tr><th>provider</th><td>${escapeHtml(repro.provider)} / ${escapeHtml(repro.model)}</td></tr>
      <tr><th>endpoint</th><td>${escapeHtml(repro.endpoint ?? '—')}</td></tr>
      <tr><th>temperature</th><td>${repro.temperature}</td></tr>
      <tr><th>seed</th><td>${repro.seed}</td></tr>
      <tr><th>repeat</th><td>${repro.repeat}</td></tr>
      <tr><th>tool order permuted</th><td>${repro.permuted}</td></tr>
      <tr><th>surface hash</th><td><code>${escapeHtml(repro.surfaceHash)}</code></td></tr>
      <tr><th>task set</th><td><code>${escapeHtml(repro.taskSetSource)}</code> (v${repro.taskSetVersion})</td></tr>
      <tr><th>provider honours a seed</th><td>${repro.providerCapabilities.seed}</td></tr>
      <tr><th>provider honours temperature 0</th><td>${repro.providerCapabilities.temperatureZero}</td></tr>
    </tbody>
  </table>
  </div>

  <footer>
    <strong>No tool was executed.</strong> whichtool read <code>tools/list</code>, recorded which tool the
    model would have called, and stopped there.
    Generated by whichtool ${escapeHtml(WHICHTOOL_VERSION)}. Every rate carries its denominator and a 95%
    Wilson interval; a percentage without one is not a measurement.
  </footer>
</main>
<script type="application/json" id="whichtool-data">${embedJson({ trials: trialData })}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
  return html
}
