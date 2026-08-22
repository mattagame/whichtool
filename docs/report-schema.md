# The JSON reports are a public contract

`--format json` emits a versioned document. Downstream tools read it, so it is treated as
an API rather than as debug output.

The machine-readable contracts ship in the npm package under `schemas/` and are exported as
package subpaths. They all use JSON Schema 2020-12.

| Artifact                 | Wire version             | Published schema                                                      | Package export                     |
| ------------------------ | ------------------------ | --------------------------------------------------------------------- | ---------------------------------- |
| Config data              | unversioned              | [`config.schema.json`](../schemas/config.schema.json)                 | `whichtool/schemas/config`         |
| Task set                 | `version: 1`             | [`task-set.schema.json`](../schemas/task-set.schema.json)             | `whichtool/schemas/task-set`       |
| Inspect report           | `whichtool.inspect/1`    | [`inspect-report.schema.json`](../schemas/inspect-report.schema.json) | `whichtool/schemas/inspect-report` |
| Run report               | `whichtool.run/2`        | [`run-report.schema.json`](../schemas/run-report.schema.json)         | `whichtool/schemas/run-report`     |
| Diff report              | `whichtool.diff/2`       | [`diff-report.schema.json`](../schemas/diff-report.schema.json)       | `whichtool/schemas/diff-report`    |
| MCP tool-result envelope | `whichtool.mcp-result/1` | [`mcp-result.schema.json`](../schemas/mcp-result.schema.json)         | `whichtool/schemas/mcp-result`     |

Shared report definitions, including `Proportion`, diagnostics and token accounting, live in
[`common.schema.json`](../schemas/common.schema.json) and are exported as
`whichtool/schemas/common`. The report schemas refer to it with relative `$ref` values, so a
consumer should keep the shipped schema directory together when resolving references.

The config schema describes the config object itself: for a JavaScript or TypeScript config,
validate the module's default export. The task-set schema describes the common data model
after parsing, so it applies equally to JSON and to whichtool's supported YAML subset.

`whichtool tasks lint` also emits `whichtool.tasks-lint/1`; it does not yet have a published
JSON Schema. These contracts are versioned independently: a change to the run report does
not force consumers of the inspect report to do anything.

Bump the version when the shape changes in a way a consumer would notice. Adding an
optional field is not that; removing one, renaming one, or changing the meaning of an
existing one is.

## Determinism

The document contains no timestamp, no duration, and no field that varies between two runs
over the same surface. Two inspections of one surface produce byte-identical JSON.

That is what makes it usable in a golden test (`tests/golden.test.ts`) and in a CI diff: a
changed report means the surface changed, never that the clock moved.

`target.ref` is a credential-redacted URL or working-directory-relative path. Absolute paths
outside the working directory are reduced to their file name, so reports carry no home path.

## Diagnostic codes are part of the contract

Every finding carries a stable `code`. Renaming one is a breaking change, on the same
footing as renaming a field.

| Prefix           | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `surface/…`      | Problems found while normalizing the served list            |
| `snapshot/…`     | Problems with the captured file itself                      |
| `mcp/…`          | Protocol-level observations: pagination, cache directives   |
| `annotations/…`  | MCP annotation coherence                                    |
| `descriptions/…` | Missing, very short, or duplicated description text         |
| `overlap/…`      | Lexical similarity between a pair of tools                  |
| `x-mcp-header/…` | Validity of header-mirroring annotations on tool parameters |
| `threshold/…`    | A configured limit was exceeded                             |

The first eight appear in an inspect report. A run, diff or tasks document adds these:

| Prefix       | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `run/…`      | The execution itself: errored trials, position sensitivity, thin data |
| `tasks/…`    | Task-set coverage and validity; also carried into a run report        |
| `diff/…`     | Comparability of two runs, and what moved between them                |
| `generate/…` | What `tasks generate` dropped from the model's draft, and why         |
| `mutate/…`   | What `tasks mutate` produced or could not apply                       |

A consumer that switches on the prefix must treat an unknown one as informational rather
than dropping it: prefixes are added as commands are added.

`severity` is one of `error`, `warning`, `info`. Diagnostics are sorted worst-first and
that order is deterministic.

## Numbers that are estimates say so

`tokens.tokenizer.exact` is `false` for the heuristic estimator, and `tokens.tokenizer.id`
names it. `tokens.serialization` records how a tool was serialized before counting, because
that choice moves the number.

The run report carries the same block under `contextCost` rather than `tokens`, so the
paths there are `contextCost.tokenizer.exact` and `contextCost.serialization`.

A consumer that renders these should keep them marked as estimates. The terminal reporter
prefixes every one with `~` for that reason.

## Sections that were not checked say so

`deprecations.checked` distinguishes "checked and found nothing" from "not checked". When it
is `true`, `deprecations.specRevision` names the MCP revision the rule table was reconciled
against and `deprecations.verifiedOn` says when. A consumer must never read an empty
`deprecations.diagnostics` as a clean bill of health without looking at `checked` first.

As of MCP 2026-07-28 the rule table is legitimately empty: none of the six entries in the
published deprecated-features registry is visible in a `tools/list` response or a `Tool`
definition. `deprecations.registrySize` records how many entries were considered.

## The run report

Three things about `whichtool.run/2` differ from the inspect report. `whichtool.run/1` is
the legacy single-call shape; new runs always emit version 2.

**The token block is named `contextCost`.** Same shape, different key, because in a run it
is one input to the result rather than the result itself.

**It is not byte-stable.** A model is involved, and `durationMs` records wall clock. Diff
the metrics, not the file.

**Every rate is an object, never a number.** `{ numerator, denominator, value, ci95 }`. A
consumer therefore cannot render a percentage without having its denominator in hand, which
is SPEC §3.2 enforced by the shape of the data rather than by discipline. When the denominator
is zero, both `value` and `ci95` are `null`: the rate is unknown in memory and on the wire.

`reproducibility` records provider, model, a credential-redacted endpoint, a non-secret request fingerprint,
declared capabilities, temperature, seed, repeat count, permutation, surface hash and
task-set identity. `diff` requires the
measurement settings and the selected tasks, prompts and expected tools to match. The surface
hash may differ: the surface change is the thing being measured.

`trials` holds the per-trial detail: the verdict, the tool order that trial used, the
position the expected tool sat in, and the argument check. Version 2 also preserves every
provider-proposed call in `calls`; the older `pick`, `arguments`, and `rawArguments` fields
are the compatibility projection of the first call. A trial with more than one call sets
`unexpectedAdditionalCalls`, uses the `unexpected-additional-calls` verdict when the first
call would otherwise have been correct, and contributes to `metrics.multiCallRate`. No call
is executed. The trial list is what `diff` and the HTML reporter read.

Readers do not trust redundant fields independently. They verify first-call projections and
multi-call flags, require each `order` to be a permutation of the reported surface, locate
`expectedPosition` from that order, and tie `execution.planned` to selected tasks × repeats.
They also recompute metrics and threshold verdicts, reconcile context-token component/tool
totals, and reject unknown properties wherever the published schema is closed.

### Headline verdicts expose their independent gates

An inspect report exposes `analysisOk` and `thresholdsOk`; its headline `ok` is true only
when both are true. In particular, an error-severity static diagnostic can never coexist
with `ok: true`. Warnings remain advisory.

A run report exposes `execution` and `thresholdsOk`; its headline `ok` is true exactly when
`execution.ok && thresholdsOk && !diagnostics.some(d => d.severity === "error")`. This keeps
provider health, configured quality gates, and other machine-detected invalidity separately
inspectable without allowing any error-severity finding to coexist with a passing headline.
Warnings remain advisory. `execution` contains:

- `planned`, `completed`, `scored`, and `errored`, so an agent need not infer run health
  from a metric denominator;
- `errorRate` in the same `{ numerator, denominator, value, ci95 }` shape as other rates;
- the applied `maxErrorRate` and `minScored` limits; and
- its own `ok` verdict.

Unless configured otherwise, a valid run requires at least one scored trial and permits at
most a 0.10 unavailable/error rate. An incomplete plan always fails execution health. These
limits are intentionally separate from model-quality thresholds: provider failure is an
execution error (CLI exit 2), while a valid run that misses a configured quality threshold
uses exit 1. A fully healthy run that meets its thresholds uses exit 0.

Legacy `whichtool.run/1` reports are migrated to the validated `/2` shape by
`whichtool report` and `whichtool diff` using those defaults and the preserved diagnostic
severities. This prevents an older all-provider-error report, or one with an error diagnostic,
whose saved `ok` happened to be true from regaining a passing verdict when re-read.

### Trial-option bounds

Config files and library entry points enforce the same operational bounds: `repeat` is an
integer from 1 through 1000, `concurrency` from 1 through 64, and `temperature` a finite
number from 0 through 2. A plan may contain at most 100,000 trials. Invalid values are
errors; they are never rounded, clamped, or turned into a zero-worker run.

## `headerParams.rejectedTools`

Tools that a conforming Streamable HTTP client will exclude from `tools/list` because their
`x-mcp-header` annotation is invalid. These tools are present in `surface.tools` and counted
in `tokens` — whichtool reports them rather than dropping them — but a model would never see
them. A consumer showing a tool count should show this alongside it.
