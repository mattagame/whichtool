# Contributing

Thanks for looking. This is a pre-1.0 project maintained by one person, so the most useful
thing you can send is usually smaller than you think: a surface that whichtool misreads, a
report field that does not mean what the docs say it means, a run whose numbers you cannot
reproduce.

## Before you write code

**Open an issue first for anything that changes behaviour.** Not as a formality — the
design record in [SPEC.md](SPEC.md) says why several things are the way they are, and a
change that contradicts it needs the reasoning updated, not just the code. A patch that
arrives without that conversation is harder to accept than one that arrives after it.

Small fixes — a typo, a broken link, an error message that misleads — need no issue. Send
them.

## Setting up

Bun is the toolchain. Node is what the package has to run on.

```bash
bun install
bun test
```

Everything the CI runs, you can run:

```bash
bun run typecheck
bun run lint
bun run format:check
bun test
bun run build
```

Run the CLI from source without installing anything:

```bash
bun run dev inspect ./tests/fixtures/servers/clean.json
```

`npx whichtool` does **not** resolve to your working tree — it goes to the registry. Use
`bun run dev` while developing.

## The constraints that are not negotiable

These are enforced by tests, not by review, so you will find out quickly. They are listed
here so the failure makes sense when you hit it.

**whichtool never executes a tool.** It reads `tools/list`, records what a model would have
called, and stops. The transport interface has exactly one method and must never gain a
second. `tests/non-execution.test.ts` fails the build if a full inspection touches anything
beyond `listTools`. This is the property that makes the tool safe to point at a production
server, so it is not traded away for a feature.

**`src/core/` is portable TypeScript.** No Bun APIs, no `node:` builtins, no `process.*`.
Anything platform-specific lives in `src/runtime/` behind an interface. Enforced by
`tests/portability.test.ts` and by keeping `@types/bun` out of the `src/` type-check.

**Terminal output is pure ASCII.** Help text and error hints included, not only the report
renderers — CI logs are not guaranteed to be UTF-8. Markdown and HTML output may use
whatever they like. Golden tests and `tests/cli.test.ts` enforce this.

**No metric without its denominator.** Every rate is a `Proportion` — `{ numerator,
denominator, value, ci95 }` — never a bare number. A consumer cannot render a percentage
without having its `n` in hand, and that is deliberate: it is the shape of the data doing
the work instead of discipline.

**Zero runtime dependencies.** This is why the YAML reader is a hand-written strict subset
that refuses what it does not understand rather than guessing. Adding a runtime dependency
is a design decision, not an implementation detail; open an issue.

**A refusal is never a silent misreading.** If input falls outside what the tool supports,
it says so with a line number and stops. Quietly accepting it and producing a different
meaning is the worst outcome available, because the number that comes out still looks fine.

## Tests

New behaviour needs a test. More usefully: if you are fixing something, write the test that
fails first, so the commit shows what was actually wrong.

The golden tests (`tests/golden/`) hold byte-exact reporter output. When you change a
renderer they will fail; read the diff before regenerating, because that diff is the entire
point of them. The captures in `examples/*/report.*` work the same way and are listed in
`.prettierignore` — a reformatted capture is no longer a capture.

## Commits and pull requests

Conventional commits: `fix:`, `feat:`, `docs:`, `chore:`, `refactor:`, `test:`, with an
optional scope like `fix(yaml):`.

Write the message for someone reading `git log` in a year with no memory of the issue. Say
what was wrong and why the fix is the right one — not what the diff already shows.

Please do **not** add `Co-Authored-By` trailers.

Keep a pull request to one subject. Two unrelated fixes are two pull requests; it makes
both easier to accept, and lets one land while the other is still being discussed.

## Releasing

Before the first tag, configure npm Trusted Publishing for this repository and the exact
`.github/workflows/release.yml` workflow, using the `npm` environment. In GitHub, create
protected `npm` and `release` environments with the required reviewer, and restrict creation
of `v*` tags to maintainers. These controls live in the hosting services; the workflow cannot
create or enforce them from the repository.

Then update `package.json`, `src/version.ts` and the changelog together, let the full `main`
workflow pass, and push a matching `v<version>` tag whose commit is on `main`. The release
workflow re-runs the quality gate, publishes npm through short-lived OIDC credentials, pushes
the container, and creates the GitHub release in that order. Standalone executables stay out
of the release until the embedded runtime's redistribution notices are complete.

## Reporting a bug

The single most useful attachment is a **snapshot that reproduces it**:

```bash
whichtool inspect <your target> --save-snapshot ./repro.json
```

Strip anything sensitive from it first — tool descriptions sometimes carry internal detail.
With that file, the behaviour is reproducible without access to your server.

Include the command you ran, what you expected, and what happened. For anything involving a
run, the saved `--format json` report says more than a screenshot does.

## Security

Do not open a public issue for anything exploitable. [SECURITY.md](SECURITY.md) has the
private reporting route.

## Licence

By contributing you agree that your contributions are licensed under the MIT licence, the
same as the rest of the project.
