# whichtool — design specification

> **Does the model actually pick the right tool from your MCP server?**

This is the design record for the project. Code comments reference its section numbers, so
the numbering is stable: add sections rather than renumbering them.

The code is the source of truth for what is built. Where the two disagree, this document is
the one that is wrong.

---

## 1. The thesis

An MCP server can have perfectly valid schemas and still be **unreadable to a model**. If
you ship `list_users` and `search_users` with similar descriptions, the model guesses, the
agent makes the wrong call, and the user sees behaviour nobody can explain. That failure
sits between schema validation and implementation tests that select the tool by construction.

`whichtool` measures it. It takes the tool surface your server exposes, puts it in front of
a real model with a set of tasks, and reports **which tool gets picked** and **which pairs
of tools get confused**.

The output is not a list of style warnings. It is a confusion matrix, a per-tool accuracy
figure, and a token cost.

## 2. Scope

`whichtool` does two jobs, and both are first-class.

**Static analysis of the surface.** Token budget, annotation coherence, descriptions that
are indistinguishable, `x-mcp-header` validity. It calls no model and needs no
model-provider key. A live target can still require its own authorization or launch a
configured stdio process. This is not scaffolding for the measurement — it is the part most
users will run most often, and it has to stand on its own.

**Single-turn routing measurement with a model in the loop.** Prepared tasks, repeated
trials, permuted ordering, confusion matrix, and rates with Wilson intervals. It costs a
model call per trial, so it is the part you run deliberately rather than on every save. It
does not execute tools or evaluate a multi-step agent workflow, tool results, recovery, or
the final answer.

The relationship between them is the interesting one: the first predicts confusion, the
second observes it, and where the two disagree there is something to learn. Neither is a
step towards the other.

Do not position the project against other tools by name in the documentation. Describe what
this does; let readers draw the comparison.

## 3. Non-negotiable design principles

1. **whichtool never executes a tool.** It reads `tools/list`, records every tool call the
   model proposes in one selection turn and its arguments, and stops there. No side effect
   on the server under test, ever. This belongs in the README in bold: it is what makes the
   tool safe to point at a production server.
2. **No metric without a denominator.** Every number reported must say how many trials it
   is computed over and with what variance. An "82%" with no `n` and no deviation does not
   get printed.
3. **Reproducibility above all.** Every run records: provider id, model id, task-set schema
   version, tool-surface hash, temperature, repeat count. Two runs on the same inputs must
   be comparable, or CI is pointless.
4. **The free command has to exist.** `whichtool inspect` calls no model and requires no
   model-provider key. A snapshot runs locally; an HTTP or stdio target may still require
   target authorization or launch the configured process. It is the front door before
   anyone configures a model provider.
5. **Absence of evidence is not evidence of quality.** If a task set is too small to be
   statistically useful, the report says so instead of printing a reassuring percentage.

## 4. Concepts and vocabulary

Use these terms consistently across the code, the CLI and the documentation.

| Term             | Meaning                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| **Target**       | The MCP server under test. Reachable over HTTP, over stdio, or as a JSON snapshot on disk.              |
| **Surface**      | The target's normalized `tools/list`: names, descriptions, input schemas, annotations.                  |
| **Surface hash** | A stable hash of the normalized surface. Identifies a version of the surface.                           |
| **Task**         | A natural-language request plus the tool expected to be chosen (`expected`), or `null` for distractors. |
| **Task set**     | A versioned collection of tasks, on file, committed to the repository of the server under test.         |
| **Distractor**   | A task no tool on the server should satisfy. Measures over-triggering.                                  |
| **Trial**        | One prepared task sent through a single model selection turn.                                           |
| **Run**          | All the trials of one invocation, plus the reproducibility metadata.                                    |
| **Pick**         | Compatibility view of the first proposed call; a trial preserves zero or more calls in provider order.  |

## 5. Architecture

```
target ──▶ transport ──▶ surface (normalize + hash)
                              │
                              ├──▶ static analysis  ──▶ token budget, annotation coherence
                              │
task set ─────────────────────┼──▶ trial planner ──▶ provider ──▶ calls (0..n)
                                                                       │
                                                                 scorer ──▶ metrics ──▶ reporters
```

Structural constraint: **`src/core/` must be portable TypeScript**, using only `fetch` and
standard APIs, with zero `Bun.*`. Bun-specific APIs (filesystem, SQLite, TTY, process spawn
for the stdio transport) live only in `src/cli/` and `src/runtime/`. The reason: the package
has to run under `npx` on Node, where most of the MCP ecosystem is, while Bun remains the
development, test and build toolchain.

### 5.1 Transport

Three implementations behind a single interface exposing one method: get the tool list.

- **`http`** — the MCP 2026-07-28 spec is stateless: no more `initialize`/`initialized`
  handshake, no `Mcp-Session-Id`; every request carries the protocol version, client
  identity and capabilities inside `_meta`, and the `Mcp-Method` and `Mcp-Name` routing
  headers are required. **Verify the exact shape of the headers and of `_meta` against the
  official spec before implementing**, and isolate these details in a single module so that
  a spec revision touches one file.
- **`stdio`** — spawn a local process and speak JSON-RPC over stdin/stdout. For servers the
  user is developing locally.
- **`snapshot`** — read a JSON file containing an already-captured `tools/list`. This is the
  transport that makes CI possible without starting anything, and the one all the tests run
  on.

The deprecated 2024-11-05 HTTP+SSE transport (`legacy-sse`) is refused: it has been
deprecated since MCP 2025-03-26 and is in the removal registry. Capture a `tools/list`
and use `--transport snapshot`, or point `--transport http` at Streamable HTTP.

### 5.2 Surface normalization

Before any analysis, the surface is brought into canonical form: stable key ordering, tools
sorted by name, whitespace normalization in descriptions, resolution of internal `$ref`s in
schemas. The hash is computed on this canonical form, so an irrelevant reordering does not
make the surface look changed.

The normalized surface also carries a **token estimate**, per tool and in total. The current
build always uses the provider-neutral `heuristic-bpe-v1`; the report declares
`tokenizer.exact: false` and the terminal prefixes the values with `~`. Use this structural
estimate to compare surfaces and spot bloat, not as a provider bill. Provider-reported usage
is authoritative when a run supplies it.

Surface size has a separate cautious guardrail. `inspect` warns above 6 tools. Real CLI,
MCP, and GitHub Action evaluations stop before a provider call above 6 by default;
`--max-tools`, `trials.maxTools`, the operator-owned MCP startup flag, or the Action's
`max-tools` input may raise the limit only up to 1,000. Six is not a universal cognitive
limit: ambiguity depends on the model, names, descriptions, schemas, and tasks. The
tool-count guard must complement, not replace, `--max-context-tokens`, because a few large
schemas can consume more context than many small ones.

### 5.3 Task set

The task file is the most important artifact in the project: it is what the maintainer of
the server commits and evolves.

```yaml
# whichtool.tasks.yaml
version: 1
surface: 'sha256:ab12...' # the surface it was generated for; warn if that changes
tasks:
  - id: users.list.basic
    prompt: 'Show me all the users in the workspace'
    expected: list_users
    tags: [users, read]
  - id: users.search.byname
    prompt: "Find the user whose name contains 'rossi'"
    expected: search_users
    tags: [users, read]
  - id: distractor.weather
    prompt: "What's the weather in Rome tomorrow?"
    expected: null # no tool should be called
    tags: [distractor]
```

Three ways to populate it, all supported:

1. **Written by hand.** The most authoritative case: the maintainer knows what they want.
2. **Generated by a model** from the tool descriptions, via `whichtool tasks generate`. The
   result is **written to a file and committed**, not regenerated on every run: generation
   is non-deterministic, execution of the tasks must not be.
3. **Mutations** of existing tasks, generated deterministically: colloquial rephrasing,
   an over-polite register, imperative versus interrogative form, introduced typos. These
   measure robustness and need no LLM when implemented as text transformations with a
   fixed seed — which also rules out translation into another language, since doing that
   deterministically without a model is not a text transformation.

The generator must produce **the distractors too**, and that is the part easiest to get
wrong: a distractor has to be plausible within the server's domain, not absurd. "What's the
weather" is a weak distractor for a user-management server; "permanently delete Rossi's
account" against a server that exposes only read-only tools is a strong one.

### 5.4 Trial planner

For each task, run `repeat` trials (default 5, configurable). The order of the tools in the
list passed to the model must be **permuted between trials**, with a seed derived
deterministically from `(task id, trial index)`: position in the list influences the model's
choice, and if you do not neutralise it you are measuring an artifact of the ordering rather
than the ambiguity of the descriptions. This is one of the technically most important points
in the whole project.

A real invocation accepts at most 50 total trials by default, counted after task filters as
`selected tasks × repeat`. `--max-trials` / `trials.maxTrials` may raise that budget only up
to the absolute execution ceiling of 1,000. A dry run may preview a larger safe-to-allocate
plan, but must say that real execution is blocked.

The same preview-before-execution rule applies to surface size: a dry run can show a plan
above the configured tool budget, but a real run must stop before provider construction or
network access. The default is 6 tools and the absolute maximum is 1,000.

Repeats measure trial-level stability for that prepared task. They do not create new
intents or make the Wilson interval an estimate of performance on unseen requests.

The prompt sent to the model must be as bare as possible: no elaborate system prompt, no
examples, no hints. Only the tool definitions exactly as the server exposes them, and the
task text as a user message. Add context and you are measuring your prompt, not the server.

### 5.5 Provider

Minimal interface: give it a set of tool definitions and a user message, receive one model
turn containing zero or more proposed tool calls. Preserve every call in provider order in
`calls`; `pick`, `arguments`, and `rawArguments` remain a compatibility projection of the
first.

Implementations: Anthropic Messages, OpenAI Responses under `openai`, explicit OpenAI Chat
Completions under `openai-chat`, chat-completions presets for Ollama, vLLM, OpenRouter and
Together, any `openai-compatible` endpoint, and a deterministic `mock` provider used by the
tests.

Each provider declares its own capabilities: does it support a seed? Temperature zero? Does
it return logprobs? The report must carry these, because they determine how much to trust
the reproducibility. Do not promise determinism the provider does not guarantee: use
`repeat` and report the variance.

Distinguish in the report between trials that failed on a network error and trials where the
model chose nothing. Conflating them falsifies every metric. Built-in HTTP providers do not
retry by default because a retry can be another billable request; programmatic callers may
opt into exponential-backoff retries explicitly.

### 5.6 Scorer and metrics

For each trial, record every proposed call and its arguments, the first-call compatibility
projection, presence of a clarifying question, usage, latency, and any provider error. No
proposed call is executed.

Metrics to compute:

- **single-call accuracy per tool** — the fraction of trials where exactly the expected tool was proposed
  and no additional call was proposed. With a Wilson interval, not bare. That interval is
  trial-level stability on prepared tasks, not generalisation to unseen intents.
- **Confusion matrix** — `expected × picked`, the central artifact of the report.
- **Confusion pair score** — for each unordered pair of tools, how much they swap. Sort the
  report by this value descending: these are the problems to fix, in order.
- **Argument accuracy** — were the `required` parameters filled? Are the values of the right
  type?
- **Hallucinated parameters** — arguments absent from the input schema. When this happens,
  the description or the schema is suggesting something that does not exist.
- **Phantom tool rate** — the model called a tool name that does not exist. A strong signal
  of incoherent naming.
- **Abstention rate** — no call on a task that required one.
- **Over-trigger rate** — a call on a distractor. The mirror of abstention: a tool that
  optimises only one makes the other worse, and the report must show them side by side.
- **Multi-call rate** — more than one proposed call in a selection turn. Preserve and score
  the additional calls even when the expected tool appears first.
- **Position sensitivity** — how much accuracy varies with the permutation. A high value
  means the model is guessing.
- **Context cost** — tokens of the `tools/list`, total and per tool, highlighting the tools
  that are most expensive relative to how often they are chosen correctly.

### 5.7 Static analysis

A first-class job in its own right (§2), not a preface to the measurement:

- Coherence of the MCP **annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`): contradictions between a hint and the semantics of the name,
  `destructiveHint: true` together with `readOnlyHint: true`, annotations absent entirely.
  Absence matters because clients then assume the worst case — not read-only, potentially
  destructive, not idempotent — and that changes the confirmation UX without the maintainer
  knowing. Note in the report that annotations are unverifiable _hints_: the protocol itself
  states that a client must not rely on them as a safety guarantee. `whichtool` checks their
  internal consistency, not their truthfulness.
- **Lexical overlap** between tools: n-gram similarity over name plus description. It serves
  as a zero-cost predictor of confusion, and in the report it belongs next to the measured
  confusion: where the two diverge there is something interesting to understand.
- **Surface size** above 6 tools, as a cautious warning rather than a universal quality
  verdict. Report it alongside the context-token estimate.
- Use of deprecated features in the surface.

### 5.8 Reporters

- **Terminal** — a readable table, the confusion matrix rendered compactly, and the three
  worst things at the top. Respects `NO_COLOR` and degrades without a TTY.
- **JSON** — a stable, versioned schema. It is the contract for downstream tools: treat it
  as a public API and version it.
- **Markdown** — intended for a pull-request comment.
- **Standalone HTML** — a single file with a navigable confusion matrix, CSS and JS inline.
  This is the artifact people screenshot, and it is free advertising for the project.
- **Badge** — a shields.io-compatible JSON endpoint generated from the run, so an MCP server
  can display its own score in its README.

## 6. CLI surface

```
whichtool inspect <target>            # surface lint; no model/provider key. Target auth may apply.
whichtool tasks generate <target>     # generate the task set and write it to a file
whichtool tasks lint                  # validate the task set: duplicate ids, non-existent expected, missing distractors
whichtool tasks mutate                # seeded robustness variants, no model
whichtool run <target>                # execute the trials and produce the report
whichtool diff <runA> <runB>          # compare two runs
whichtool report <run>                # re-render a saved run in another format
whichtool cache <clear|info>
whichtool mcp                         # run as an MCP server
```

`whichtool mcp` exposes four operations over prepared artifacts: inspect a surface,
validate a task file, dry-run or run the single-turn routing benchmark, and compare saved
results. It does not generate task sets or execute an agent workflow. Startup accepts only
an explicit data-only JSON config; real provider calls require the operator capability
`--allow-paid-runs`. Its real-run budget is operator-owned: startup `--max-trials`, then the
reviewed config, then 50; its tool budget follows startup `--max-tools`, reviewed config,
then 6. An agent tool call cannot raise either budget, and 1,000 remains absolute for both.

Main flags for `run`:

```
--tasks <file>            --provider <name>        --model <id>
--repeat <n>              --max-trials <n>         --max-tools <n>
--concurrency <n>
--temperature <f>
--seed <n>                --permute / --no-permute
--format <terminal|json|markdown|html|junit|badge>   --out <file>
--min-accuracy <f>        --max-over-trigger <f>   --max-context-tokens <n>
--only <tag>              --skip <tag>
--dry-run                 # count trials and prompt tokens, without calling the model
```

`--dry-run` is essential before a paid run. Its prompt-token figure is a lower bound, not a
price estimate: output and reasoning tokens are additional, and provider pricing can change.

Exit codes: `0` execution was healthy and every threshold met, `1` a quality threshold was
violated, `2` execution was unhealthy or failed, and `130` means the operator interrupted a
run with `Ctrl+C`. Interruption aborts in-flight provider requests and writes no partial
report. MCP evaluations remain cancellable through the protocol.

## 7. Configuration

`whichtool.config.ts` (with `whichtool.config.json` supported too), typed and exported from
the package so the editor completes the fields:

```ts
import { defineConfig } from 'whichtool'

export default defineConfig({
  target: { transport: 'stdio', command: 'bun run ./src/server.ts' },
  tasks: './whichtool.tasks.yaml',
  provider: { name: 'ollama', model: 'qwen3:4b' },
  trials: {
    repeat: 5,
    maxTrials: 50,
    maxTools: 6,
    permute: true,
    temperature: 0,
    concurrency: 4,
  },
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

Environment variables for API keys follow each provider's conventions, and are **never**
written to a saved run, a log, or a report. Verify this with a dedicated test.

The human CLI may load TypeScript or JavaScript config. The agent-facing MCP server never
discovers executable config and accepts only a reviewed JSON file passed explicitly with
`--config`.

## 8. Cache

A portable local JSON cache. Its versioned key hashes provider, endpoint, model,
temperature, trial seed, ordered tool definitions, task prompt, and an opaque provider
fingerprint covering construction options that can change behaviour, such as API shape,
reasoning settings and headers. Credentials influence isolation only
through the digest and are never written in clear text. With that key, every repetition
stays distinct and a repeated run with no changes costs nothing.

A surface change changes the tool definitions in the key and therefore misses safely.
Arbitrary request-body overrides are not part of the provider API: the harness owns model,
prompt, tools, sampling and reasoning fields so a caller cannot silently change what was
measured. The cached value contains all proposed calls, arguments, provider response text
and usage metadata. It is inspectable and clearable from the CLI; `--no-cache` bypasses it.

## 9. Repository layout

```
whichtool/
├── package.json            # bin: whichtool; exports: ./ (lib) and ./config
├── tsconfig.json
├── src/
│   ├── core/               # portable TS, zero Bun APIs
│   │   ├── transport/      # MCP protocol plus HTTP, stdio and snapshot transports
│   │   ├── surface/        # fetch.ts, normalize.ts, hash.ts, tokens.ts
│   │   ├── tasks/          # schema.ts, load.ts, generate.ts, mutate.ts, validate.ts
│   │   ├── eval/           # planner.ts, runner.ts, scorer.ts, metrics.ts
│   │   ├── providers/      # Anthropic, OpenAI Responses/chat-compatible, deterministic mock
│   │   ├── static/         # annotations, overlap, headers and deprecations
│   │   └── report/         # terminal, markdown, HTML, JUnit and badge reporters
│   ├── runtime/            # filesystem and process adapters for Bun and Node
│   └── cli/                # argument parsing, config loader, output
├── tests/
│   ├── fixtures/servers/   # fake surfaces with intentional ambiguity
│   └── golden/             # expected reporter output
├── docs/
├── examples/               # a deliberately ambiguous MCP server, with the report that proves it
├── action.yml              # GitHub Action
└── .github/workflows/
```

The fixtures with intentional ambiguity earn their keep twice: they are the basis of the
tests and they are the README's demo. Build a small set covering the typical cases — a
list/search pair, a get/fetch pair, tools with inconsistent prefixes, tools with no
annotations, copied descriptions — and document, for each, the failure it provokes.

## 10. Testing

- **Unit** tests on normalization, hash, token counting, scorer, metrics, mutations. The
  metrics are tested with hand-built trials whose expected result can be computed by hand.
- **Reporters** with golden files: changing an output is then a visible diff.
- A deterministic **mock provider** that allows scripting the picks and exercising the whole
  pipeline without a network.
- **Transport** against a fake in-process MCP server; the HTTP transport against a handler
  that verifies the routing headers are correct.
- A **non-execution test**: a fixture that records every call it receives, and a test
  asserting that after a complete run the server received only `tools/list`. This protects
  the most important design principle.
- **Anti-leak tests** for API keys in the outputs.

Use `bun test`, no additional framework.

## 11. Distribution

- Automated release publication is temporarily paused. The npm package may be unavailable,
  while the public source remains runnable from a GitHub checkout. Registry, Action, and
  container distribution targets below remain the intended future channels.
- **npm**, runnable with `npx whichtool` and `bunx whichtool`. It must work on Node: verify
  that in CI with a Node and Bun matrix.
- **Compiled binary builds** exist for Linux, macOS and Windows, but are not distributed.
  Publication stays disabled until the embedded runtime's third-party redistribution
  notices have been reviewed and can accompany every binary.
- A **GitHub Action** (`action.yml`) that executes a run, writes the accuracy delta against
  the base branch into the job summary, and fails the check when a threshold is exceeded.
- A **container image** for people who want to run it in a non-JS pipeline.

## 12. Verify before writing the transport

Do not infer these details, read them from the source:

- The MCP 2026-07-28 spec is recent: verify on `modelcontextprotocol.io` the exact shape of
  `_meta`, the names and values of the routing headers, and the cache fields on `tools/list`
  responses (`ttlMs`, `cacheScope`).
- Verify the current status of the deprecated features, so the right warnings are emitted.
- For each provider, verify how tools are declared, whether a seed parameter exists, and how
  a tool call is forced. Do not assume symmetry between providers.

## 13. What a number from whichtool means

Every figure the tool prints is a statement about one specific thing, and saying which
thing keeps the report honest. Most scope questions answer themselves once this is stated
plainly, so state it plainly.

**It measures a surface, at one model.** The subject is the server's tool descriptions;
the model is part of the apparatus, held fixed. Swap the model and the next number answers
a different question, which is why `diff` refuses to subtract two runs that used different
models rather than reporting a delta nobody can interpret.

**It measures one selection turn on prepared tasks.** A trial ends after one model response,
whether that response proposes no call, one call, or several. Every proposed call is
recorded and none is executed. Tool results, recovery, subsequent turns and final-answer
quality belong to an agent or implementation evaluation outside whichtool's scope.

**Its intervals are conditional on those tasks.** Wilson intervals describe trial-level
stability for the prepared requests in the task set. Repeats do not estimate performance on
unseen intents; broader claims require adding distinct, reviewed tasks.

**The static checks are a first-class result, not a warm-up.** `inspect` is a linter for a
tool surface and is meant to be judged as one: it calls no model and needs no model-provider
key. A live target can still require its own authorization. Most users will run it far more
often than they run a measurement.

**Diagnosis stops where the domain begins.** The tool says two descriptions are
indistinguishable and shows the evidence. Choosing the words that distinguish them belongs
to whoever owns the domain, and a generated rewrite would read as authoritative while
knowing nothing about it.
