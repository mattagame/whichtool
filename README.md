# whichtool

<p align="center">
  <img src="assets/whichtool.png" alt="One tool surface, four tools, one selected." width="160">
</p>

**Does the model actually pick the right tool from your MCP server?**

[Italiano](README.it.md)

An MCP server can have valid schemas and still be unreadable to a model. Ship `list_users` and `search_users` with similar descriptions and the model guesses. Schema validation still passes. Integration tests pass too, because they call the right tool by construction.

whichtool puts that surface in front of a real model and reports **which tool gets picked** and **which pairs get confused**.

**whichtool never executes a tool.** It reads `tools/list`, records what the model would have called, and stops.

It is deliberately a **single-turn routing benchmark**. It measures the model's tool-selection
decision on a prepared set of intents; it does not evaluate multi-step agent execution,
semantic argument correctness beyond a shallow schema check, tool results, recovery, or the
quality of a final answer.

Every call proposed in that turn is retained in the JSON report's `trials[].calls`; the
first-call fields remain a compatibility view, not a reason to discard additional calls.

It does two jobs:

- **`inspect`** — token budget, contradictory annotations, near-identical descriptions, invalid `x-mcp-header` values. No model call or model-provider key; a live target may still require its own authorization.
- **`run`** — trials, permuted tool order, confusion matrix, rates with Wilson 95% intervals.

Those Wilson intervals describe trial-level stability on the tasks in the file. Repeating a
task measures whether that same routing decision is stable; it does not estimate how the
model will perform on unseen intents.

## Install

```bash
npx whichtool inspect ./tools.json
# or: bunx whichtool inspect ./tools.json
```

```bash
npm install --save-dev whichtool
```

Requires Node 20.11+ or Bun 1.3+. Zero runtime dependencies.

Standalone binaries are not published yet. Bun-compiled executables embed third-party
runtime components, so distribution stays disabled until their redistribution notices have
been reviewed and can ship with every binary. Use `npx` or the container in the meantime.

## Quick start

```bash
# 1. Look at the surface (no model-provider key)
whichtool inspect ./tools.json
whichtool inspect https://example.com/mcp
whichtool inspect --transport stdio "bun run ./src/server.ts"

# Capture once, work offline afterwards
whichtool inspect --transport stdio "npx -y @modelcontextprotocol/server-filesystem ." \
  --save-snapshot ./tools.json
```

Snapshots may be `{ "tools": [ … ] }`, a JSON-RPC `tools/list` envelope, or a bare array.

```yaml
# 2. Write a task set (whichtool.tasks.yaml)
version: 1
tasks:
  - id: users.list.basic
    prompt: 'Show me all the users in the workspace'
    expected: list_users
  - id: users.search.byname
    prompt: "Find the user whose name contains 'rossi'"
    expected: search_users
  - id: distractor.delete
    prompt: 'Permanently delete the account belonging to Rossi'
    expected: null
```

`expected` must be written even when it is `null`. Full format: [docs/task-sets.md](docs/task-sets.md).

```bash
# Or draft one instead of writing step 2 by hand, then edit and commit the result
# (do not regenerate on every run). It refuses to overwrite without --force.
whichtool tasks generate ./tools.json --provider ollama --model qwen3:4b --out whichtool.tasks.yaml

# Seeded robustness variants, no model
whichtool tasks mutate --out whichtool.tasks.mutated.yaml --seed 0

# 3. Lint before spending anything
whichtool tasks lint ./tools.json --tasks ./whichtool.tasks.yaml

# 4. Cost estimate (no model call)
whichtool run ./tools.json --provider ollama --model qwen3:4b --repeat 5 --dry-run

# 5. Measure
whichtool run ./tools.json --provider ollama --model qwen3:4b --repeat 5
OPENAI_API_KEY=sk-… whichtool run ./tools.json --provider openai --model gpt-4.1-mini
```

Exit codes: `0` execution was healthy and thresholds held, `1` a quality threshold failed,
`2` an execution error (including an incomplete run or too many provider failures). By
default a run needs at least one scored trial and permits at most a 10% provider-error rate;
override these with `--min-scored` and `--max-error-rate`.

```bash
# 6. Re-render, gate, compare
whichtool run … --format json --out run.json
whichtool report run.json --format markdown
whichtool report run.json --format html --out report.html
whichtool diff base-run.json head-run.json --max-accuracy-drop 0.05
```

`diff` refuses to subtract runs that used a different model, endpoint, non-secret provider
request fingerprint, temperature, seed, repeat count, permutation setting, or task set. It
matches outcomes by task and trial index, then uses an exact two-sided paired sign test
(`p <= 0.05`) to decide whether a movement is distinguishable. A distinguishable increase
in unexpected multi-call behaviour is a regression even when the first picks did not move.

## Commands

| Command                             | What it does                                            |
| ----------------------------------- | ------------------------------------------------------- |
| `whichtool inspect <target>`        | Surface lint. No model call or model-provider key.      |
| `whichtool mcp`                     | Expose prepared routing-evaluation operations over MCP. |
| `whichtool tasks lint [target]`     | Validate a task set.                                    |
| `whichtool tasks generate <target>` | Draft a task set from the tool descriptions.            |
| `whichtool tasks mutate`            | Seeded robustness variants. No model.                   |
| `whichtool run <target>`            | Execute trials and write a report.                      |
| `whichtool report <run.json>`       | Re-render a saved run.                                  |
| `whichtool diff <base> <head>`      | Compare two saved runs.                                 |
| `whichtool cache info\|clear`       | Inspect or clear the trial cache.                       |

`whichtool <command> --help` lists flags. Main flags on `run`:

```
--tasks --provider --model --repeat --concurrency --temperature --seed
--min-scored --max-error-rate
--permute / --no-permute --format --out --min-accuracy --max-over-trigger
--max-context-tokens --only --skip --dry-run --seconds-per-trial --reasoning-effort
--cache / --no-cache --cache-dir
```

Formats: `terminal`, `json`, `markdown`, `html`, `junit`, `badge`.

**Environment:** an HTTP-target credential needs both `WHICHTOOL_HTTP_AUTHORIZATION` and the exact allowed origin in `WHICHTOOL_HTTP_AUTHORIZATION_ORIGIN` (for example `https://mcp.example`). Remote credentials require HTTPS. Provider keys come from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, and `WHICHTOOL_PROVIDER_API_KEY` for an `openai-compatible` endpoint. `NO_COLOR` / `FORCE_COLOR` are honoured.

| Transport    | Notes                                              |
| ------------ | -------------------------------------------------- |
| `snapshot`   | Captured `tools/list` on disk. What CI should use. |
| `http`       | Streamable HTTP (MCP 2026-07-28).                  |
| `stdio`      | Locally launched server.                           |
| `legacy-sse` | Refused. Deprecated since MCP 2025-03-26.          |

Providers: `anthropic`, `ollama`, `openai`, `openai-chat`, `openrouter`, `together`, `vllm`,
any `openai-compatible` endpoint, and a deterministic `mock`. `openai` uses the OpenAI
Responses API. Select `openai-chat` explicitly for OpenAI Chat Completions; the other
OpenAI-compatible presets continue to use their chat-completions endpoints.

`anthropic` speaks the Messages API rather than a chat-completions dialect. That provider
does not send temperature or seed and records those capabilities as unsupported, so its
runs lean on `--repeat` and the trial-level intervals instead.

## Configuration

```ts
import { defineConfig } from 'whichtool'

export default defineConfig({
  target: { transport: 'stdio', command: 'bun run ./src/server.ts' },
  tasks: './whichtool.tasks.yaml',
  provider: { name: 'ollama', model: 'qwen3:4b' },
  trials: { repeat: 5, permute: true, temperature: 0, concurrency: 4 },
  thresholds: {
    minAccuracy: 0.9,
    maxOverTrigger: 0.05,
    maxContextTokens: 4000,
    maxErrorRate: 0.1,
    minScored: 1,
  },
  report: { formats: ['terminal', 'json'], out: './whichtool-report' },
})
```

`whichtool.config.json` works too. API keys are never a config field. The normal CLI can
also discover JavaScript or TypeScript config; the MCP server intentionally does not, as
explained below.

## CI

```yaml
- uses: mattagame/whichtool@v0.1.0
  with:
    target: ./tools.json
    tasks: ./whichtool.tasks.yaml
    provider: openai
    model: gpt-4.1-mini
    min-accuracy: '0.9'
    max-over-trigger: '0.05'
```

Trial caching in the composite action is disabled by default because a cache can contain prompts, tool definitions,
and provider responses. Set `cache: 'true'` only when that material is non-sensitive and
GitHub-hosted persistence is acceptable.

Omit `provider` to run only the free static pass: `inspect`, plus `tasks lint` when a task set is present. A full workflow (including a base-branch comparison written to the job summary) is in [examples/github-action](examples/github-action).

As an MCP server:

```json
{
  "mcpServers": {
    "whichtool": {
      "command": "npx",
      "args": ["-y", "whichtool", "mcp", "--config", "whichtool.config.json"]
    }
  }
}
```

The MCP server is deliberately capability-limited by its startup arguments. It does not
auto-discover or execute JavaScript/TypeScript config: pass a reviewed JSON file explicitly
with `--config`. Tool calls use the configured target and cannot replace it with an
arbitrary path, URL, or subprocess. Agent-selected task/report inputs must stay in the
working directory.

The intended agent workflow starts from evaluation artifacts you have already prepared and
reviewed: `inspect_surface`, `validate_task_file`, `run_evaluation`, then
`diff_saved_results` on saved runs. The MCP surface does not generate or mutate task sets.
It exposes the same single-turn routing benchmark; it is not an evaluator or executor for a
complete agent workflow.
`run_evaluation` can always produce a dry-run plan, but cannot contact a provider unless the
operator starts the server with `--allow-paid-runs`; `repeat`, total trials, and concurrency
also have hard caps. A full run returns a compact summary. Add
`--result-file ./latest-run.json` to keep the complete report outside model context.
`--allow-dynamic-targets` exists for isolated development setups and should be treated as
an unsafe opt-in. Provider/model overrides are likewise config-only unless the operator
adds `--allow-provider-overrides`. Persistent trial caching is off in MCP mode; the operator
must add `--cache` explicitly after deciding that prompts, calls and responses may be written
to disk.

## Examples

| Example                                       | What it shows                                          |
| --------------------------------------------- | ------------------------------------------------------ |
| [quickstart](examples/quickstart)             | The full loop on a surface you can run locally.        |
| [ambiguous-server](examples/ambiguous-server) | A deliberately unreadable surface.                     |
| [ollama-qwen3](examples/ollama-qwen3)         | A local-model run that disagrees with the static lint. |
| [github-action](examples/github-action)       | CI wiring with a base-branch diff.                     |

On reasoning models such as qwen3, a single trial can take tens of seconds of thinking tokens whichtool never reads. Measure one trial, then pass `--dry-run --seconds-per-trial`.

## Development

Bun is the toolchain; Node is the distribution target. `src/core/` is portable TypeScript (no Bun/Node builtins).

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run build
```

```bash
docker run --rm -v "$PWD:/work" ghcr.io/mattagame/whichtool inspect ./tools.json
```

Patches welcome: [CONTRIBUTING.md](CONTRIBUTING.md) lists the constraints that tests enforce rather than reviewers.

Design record: [SPEC.md](SPEC.md). Security: [SECURITY.md](SECURITY.md). JSON contract: [docs/report-schema.md](docs/report-schema.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Disclaimer

Software is provided as-is, without warranty. See [LICENSE.md](LICENSE.md).

- **`run` costs money** on hosted providers. Tool definitions and prompts are sent to the model you configure. Use `--dry-run` first. Ollama and other local endpoints stay on your machine.
- **Tools on the server under test are never invoked.** `stdio` does launch the command you pass, with your privileges — treat that command as code.
- **Standalone binaries are not distributed yet.** Publication stays disabled until the embedded runtime's third-party notices have been reviewed and can ship beside each binary.
- **Not a security scanner.** A surface can pass `inspect` and still be dangerous. Details: [SECURITY.md](SECURITY.md).

## Licence

MIT — [LICENSE.md](LICENSE.md).
