# CI wiring

> [!WARNING]
> Automated publication is temporarily paused and the npm package may be unavailable. This
> workflow is retained as the intended setup for a possible future republication; while the
> package is absent, its measured steps cannot install the CLI from npm.

`whichtool.yml` is a complete GitHub Actions workflow. Copy it to
`.github/workflows/whichtool.yml` and adjust the paths.

## What it does

**On every push and pull request**, a free pass that needs no key and no model: validate the
task set, inspect the surface, fail if the tool definitions grew past the token budget, and
write the surface report into the job summary.

**On a pull request from the same repository**, a measured run, plus the same run against
the base branch, plus a delta written into the job summary. Each real invocation blocks
above 6 tools by default before contacting the provider; the Action's explicit `max-tools`
input can raise the limit only up to 1,000.

## Three things it does on purpose

**It skips the measured run on forks.** A fork has no access to repository secrets, so the
run would fail with an authentication error that says nothing about the pull request. The
static pass still runs, and still catches identical descriptions and annotation
contradictions.

**It does not cache trials unless you opt in.** Trial caches can contain prompts, tool
definitions, and provider responses. Set the repository variable
`WHICHTOOL_ENABLE_CACHE=true` only when that material is non-sensitive and GitHub-hosted
persistence is acceptable. The example then uses an exact, per-ref cache key; it never
restores a broader cache or a cache from the default branch into a pull request.

**It runs the base branch with identical settings.** `whichtool diff` refuses to subtract
runs that differ in model, temperature, repeat count or permutation setting, so the two run
steps deliberately repeat every flag. If you change one, change both.

## Reading the delta

`diff` matches the base and head outcomes by task and trial index, then applies an exact
two-sided paired sign test. A movement is distinguishable at `p <= 0.05`; otherwise it is
reported as a paired result that is inconclusive. A new confusion fails the gate only when
paired introductions versus resolutions meet the same criterion. The Wilson intervals in
each individual report are not used as an interval-overlap test.

`--max-accuracy-drop` controls the allowed effect size. `--repeat` supplies more paired
observations and can increase the sign test's power, but repeats only measure stability on
the task file committed here. Neither the test nor the Wilson intervals estimate
generalisation to unseen intents.

This workflow benchmarks a model's single-turn routing decision. It does not execute a tool
or evaluate arguments, multi-step agent behaviour, recovery, or final-answer quality.

## Publishing a badge

The workflow writes `whichtool-badge.json` as a shields.io endpoint document. Publish it
somewhere reachable and point a badge at it:

```markdown
![tool selection](https://img.shields.io/endpoint?url=https://example.com/whichtool-badge.json)
```

The message carries the trial count — `92% of 50` — because a badge is the most quotable
number a project emits and the easiest place to lose a denominator.
