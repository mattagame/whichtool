# Security

## Reporting a vulnerability

Report privately through this repository's **Security** tab, using _Report a vulnerability_.
Please do not open a public issue for anything exploitable.

Include what you were pointing whichtool at, the command you ran, and what happened. A
snapshot file that reproduces the problem is the single most useful thing you can attach —
strip anything sensitive from it first, since tool descriptions sometimes carry internal
detail.

Expect an acknowledgement within a week. If a fix is warranted it ships in a patch release
with an advisory naming the affected versions.

## Supported versions

Pre-1.0. Only the latest published version receives fixes.

## What whichtool does to the server you point it at

**It reads `tools/list` and nothing else.** It records which tool a model _would_ have
called and with which arguments, and stops there. No tool is ever invoked, so no side
effect can reach the server under test.

This is not a convention that could drift. The transport interface exposes exactly one
method and there is nowhere to put a second, and `tests/non-execution.test.ts` fails the
build if a full inspection ever touches anything beyond `listTools`. That does not make
whichtool a sandbox: `stdio` still launches the command you named, with your privileges.

## What leaves your machine

`inspect` never sends your tool definitions anywhere. What it does depends on the transport:

| Transport  | What happens                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `snapshot` | Nothing leaves the machine and no process is launched. `tests/non-execution.test.ts` stubs `fetch` to throw for the duration of a full CLI run and asserts it is never called.                                                                                                                                                                         |
| `http`     | One HTTP(S) POST per page of `tools/list`, to the URL you supplied; redirects are rejected. A remote Authorization header requires HTTPS, while loopback development may use HTTP. The request carries the protocol version, client capabilities, and whichtool's identity. Nothing about your surface is uploaded — the surface is what comes _back_. |
| `stdio`    | The command you supplied is launched as a subprocess, with no shell, and spoken to over its standard streams. Treat a stdio command line as code, because it is.                                                                                                                                                                                       |

`run` sends your tool definitions and task prompts to the model provider you configure.
Names, descriptions and input schemas all go into the request: putting them in front of a
real model is the measurement. If descriptions contain internal hostnames, customer names,
or unreleased product detail, that detail reaches the provider.

Choose the provider accordingly. The OpenAI-compatible provider covers self-hosted
endpoints (Ollama, vLLM) if the evaluation must stay on your hardware. No tool results are
ever sent, because no tool is ever run.

## Credentials

Model-provider API keys are read only from the provider's environment variable. An HTTP
target credential uses `WHICHTOOL_HTTP_AUTHORIZATION` together with an exact origin in
`WHICHTOOL_HTTP_AUTHORIZATION_ORIGIN`. whichtool refuses an origin mismatch, and refuses any
Authorization header over plain HTTP to a non-loopback host. The programmatic `TargetSpec`
also accepts headers for callers that manage secrets themselves. whichtool never records a
configured credential itself. A remote service can still echo data it received into its
response, so treat artifacts from an untrusted target or provider as untrusted input and
inspect them before sharing. Do not commit credentials in a config file.

Display URLs never retain userinfo, query values or fragments. Long token-like path segments
are redacted as well; the original URL is used only for the actual request and inside a
one-way request fingerprint. A short or ordinary-looking path secret cannot be distinguished
reliably from a route and may remain, so do not put credentials in URLs. Prefer the
origin-bound environment pair, whose value is never written to an artifact. Reports created
before this redaction should still be treated as sensitive.

## Agent-facing MCP server

`whichtool mcp` treats the process startup configuration as the operator's authority. By
default, an agent cannot replace its configured target with a snapshot path, remote URL, or
stdio command. Even with `--allow-dynamic-targets`, a dynamic URL never receives the host's
HTTP authorization environment variables. Agent-selected task and saved-run paths are
confined to the server working directory.

MCP startup does not discover or execute JavaScript or TypeScript configuration. The
operator must pass a reviewed, data-only JSON config explicitly with `--config`. The four
tools inspect a surface or operate on prepared task files and saved reports; they expose a
single-turn routing benchmark, not execution of a complete agent workflow.

Real provider calls are disabled by default. A blocked `run_evaluation` returns its trial and
token plan as structured data; only the startup flag `--allow-paid-runs` grants the capability
to proceed. The provider and model remain config-owned unless the separate
`--allow-provider-overrides` capability is granted. Repeat, total-trial, and concurrency
limits are enforced in code, including for a raw client that bypasses the advertised JSON
Schema. `--result-file` is an operator-selected destination for the full report; the tool
response omits per-trial payloads to protect model context. Persistent caching is disabled
in MCP mode unless the operator explicitly starts it with `--cache`.

An stdio target receives a small runtime environment allowlist, not the whole whichtool
process environment. Provider keys and unrelated tokens are excluded. A target-specific
value is passed only when the trusted target config names it in `target.env`.

If you find a path where a credential reaches a file, that is a vulnerability under this
policy — please report it.

## The local cache

The cache stores prompts, tool definitions, every proposed tool call and its arguments,
provider response text, and usage metadata. Its key covers the visible trial inputs plus an
opaque provider-behaviour fingerprint, so endpoint, API shape, reasoning options,
request-construction settings and secret-bearing headers cannot accidentally share entries.
Only the digest is written; raw credentials are not.

The cache lives under the working directory and is plain local data, not encrypted. It
inherits the sensitivity of both the surface and the provider response. `whichtool cache
clear` removes it, and `--no-cache` skips it.

## What whichtool is not

- **Not a security scanner.** It does not look for prompt injection, does not assess
  whether a tool is safe to expose, and does not audit your server's implementation. Use it
  alongside a security review, never instead of one.
- **Not a validator of annotations.** MCP annotations (`readOnlyHint`, `destructiveHint`,
  and friends) are unverifiable claims made by the server. The protocol itself states that
  a client must not rely on them as a security boundary. whichtool checks that they are
  internally consistent — it cannot check that they are true, because establishing that
  would require running the tool.
- **Not a sandbox.** Loading a `whichtool.config.ts` and launching a `stdio` target both
  execute content you supplied. The stdio command line is tokenised, never handed to a
  shell, so a `;` or a backtick inside it stays part of one argument instead of starting a
  second command. The child receives a reduced environment, but still runs with your filesystem
  and process privileges. Treat a config file and a stdio command line as code, because they
  are.

## What the static checks do and do not cover

whichtool lints the surface for readability and coherence: token budget, annotations that
contradict the names they sit on, indistinguishable descriptions, invalid `x-mcp-header`
annotations. None of that is a security review. A surface can pass every check here and
still expose an operation that should never have been exposed, or describe a destructive
tool in reassuring language. Read the tools yourself.
