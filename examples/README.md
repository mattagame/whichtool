# Examples

| Directory                            | What it is for                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [quickstart](quickstart)             | The whole loop — inspect, lint, dry-run, run, report, diff — on files in the directory. Start here.   |
| [ambiguous-server](ambiguous-server) | A deliberately unreadable surface with seven distinct flaws, six of which the committed report finds. |
| [ollama-qwen3](ollama-qwen3)         | A real run against a local model. Read this one for the result, not the mechanics.                    |
| [github-action](github-action)       | A complete CI workflow, including a base-branch comparison and optional trial caching.                |

## The two to read

**[quickstart](quickstart)** — because it contains the complete reproducible path on local
files: inspect the surface, lint a reviewed task set, dry-run the cost, measure, re-render,
and compare two saved runs. Use it to learn the mechanics before connecting a live server
or hosted provider.

**[ollama-qwen3](ollama-qwen3)** — because it contradicts the static analysis. On a surface
where two tools have byte-identical descriptions, which `inspect` calls the worst problem
there, the model confused them zero times out of twelve; it disambiguated from the input
schemas instead.

Neither half of that is interesting alone. `inspect` would have sent you to rewrite
descriptions that were costing nothing. `run` would not have told you the surface is one
schema change away from being ambiguous. The gap between what static analysis predicts and
what a model does is the reason this project exists.

The measured examples are single-turn routing benchmarks. Their Wilson intervals describe
trial-level stability on the committed tasks, not performance on unseen intents, and they
do not cover multi-step agent execution or tool results.

## Running them

Every command in these directories is written for the published package, as `whichtool …`.
With it installed, `npx whichtool …` runs them as shown. From a checkout of this repository
run the CLI file directly, from inside the example directory:

```bash
bun ../../src/cli/main.ts inspect
```

That runs the same CLI from source without installing anything — `npx` would go to the
registry rather than to your working tree. (`bun run dev` executes from the repository
root, so the flag-less commands above would not find the example's config from there.)

The `inspect`, `tasks lint` and `--dry-run` paths need no API key, no model and no network.
