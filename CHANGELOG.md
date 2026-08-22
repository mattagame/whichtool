# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two things are versioned separately from the package and are called out when they move,
because downstream tools read them as contracts:

- the **report schema** (`whichtool.inspect/1`, `whichtool.run/2`, `whichtool.diff/2`,
  `whichtool.tasks-lint/1`) — see [docs/report-schema.md](docs/report-schema.md)
- the **diagnostic codes**, where renaming one is a breaking change on the same footing as
  renaming a field

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-08-21

The first release.

### Added

- `inspect` — surface lint with no model call or model-provider key: token budget per tool,
  contradictory MCP annotations, missing and duplicated descriptions, lexical overlap
  between tool pairs, and `x-mcp-header` validity. A live target may still require its own
  authorization.
- `run` — a single-turn routing benchmark against a real model with permuted tool order,
  producing a confusion matrix, per-tool single-call accuracy, over-trigger and abstention
  rates, each with a Wilson 95% interval. These intervals describe trial-level stability on the
  prepared tasks; they do not estimate generalisation to unseen intents or evaluate
  multi-step agent execution. Every call proposed in the selection turn is retained in
  `trials[].calls`; additional calls are measured rather than discarded behind the first
  one.
- `tasks lint`, `tasks generate`, `tasks mutate` — validate a task set, draft one from the
  tool descriptions, and derive seeded robustness variants without a model.
- `diff` — compare two saved runs, refusing to subtract runs whose model, endpoint,
  request fingerprint, temperature, seed, repeat count, permutation setting or task set
  differ. Outcomes are matched by task and trial index and assessed with an exact two-sided
  paired sign test; distinguishable multi-call regressions fail even when first picks stay
  unchanged.
- `report` — re-render a saved run as `terminal`, `json`, `markdown`, `html`, `junit` or
  `badge`, calling no model and re-reading no server.
- `cache info` / `cache clear` — a local trial cache keyed by provider, endpoint, model,
  sampling inputs, ordered tool definitions, prompt, and an opaque fingerprint of provider
  options that can change behaviour, so an unchanged rerun costs nothing without sharing
  entries across materially different provider configurations.
- `mcp` — run whichtool itself as an MCP server, so an agent can inspect a surface,
  validate a prepared task file, dry-run or execute an evaluation, and compare saved runs.
  MCP startup accepts only an explicitly selected JSON config, real provider calls require
  `--allow-paid-runs`, persistent caching requires an explicit `--cache`, and
  target/provider overrides are separate unsafe opt-ins.
- Transports: `snapshot`, Streamable HTTP (MCP 2026-07-28) and `stdio`. `legacy-sse` is
  refused by name, deprecated since MCP 2025-03-26.
- `--reasoning-effort`, forwarded where supported, recorded in the run, included in the
  cache fingerprint, and compared by `diff`.
- Providers: `anthropic` (Messages API), `openai` (Responses API), explicit
  `openai-chat` (Chat Completions), `ollama`, `openrouter`, `together`, `vllm`, any
  OpenAI-compatible endpoint, and a deterministic `mock`.
- A GitHub composite action and a container image. Standalone binary builds exist, but
  publication is deferred until complete notices for the embedded runtime can accompany
  them.
- Zero runtime dependencies, including a hand-written strict YAML subset that refuses what
  it does not understand rather than guessing at it.

### Fixed

These landed before the first release, so no published version ever carried them. They are
listed because each one broke a documented path.

- Arbitrary provider `extraBody` overrides could silently replace the model, prompt, tool
  list, sampling policy or reasoning settings owned by the harness. The escape hatch was
  removed before release.

- `tasks mutate` wrote `derivedFrom` as a flow mapping, which the task-set reader refuses
  by design. The file it produced could not be read back, breaking the documented
  mutate → lint → run loop at the second step.
- The YAML reader stripped `#` comments and dropped blank lines inside `|` and `>` block
  scalars, where both are content. A multi-line prompt reached the model with text silently
  deleted — the one failure the strict subset exists to prevent.
- `whichtool tasks --help` and `whichtool cache --help` exited 2 instead of printing help.
- `report --help` advertised five output formats while accepting six; `--format junit`
  worked and went undocumented.
- Help text and error hints carried non-ASCII characters, which terminal output is not
  meant to.
- The release workflow tagged the container image with the repository owner's stored
  casing, which an OCI reference forbids, so every tagged release would have failed at the
  push.
- The composite action guarded its `accuracy` output with `Number.isNaN`, but an unmeasured
  rate serialises to `null`, so the guard never fired and the output was the string
  `"null"`.
- In the example CI workflow, `diff` and `report` returned the run's verdict as their exit
  code, which under `bash -e` skipped the job summary and the badge in exactly the cases
  where the check had gone red.
- The trial-order separator was a literal NUL byte in the source, which made git treat
  `src/core/eval/planner.ts` as binary and hide its textual changes from normal diffs.

[unreleased]: https://github.com/mattagame/whichtool/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mattagame/whichtool/releases/tag/v0.1.0
