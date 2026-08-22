# A real run against a local model

`report.txt` is the unedited output of one `whichtool run`, against a model running on a
laptop. It is here because the result is not what the static analysis predicts, and that
gap is the argument for the whole project.

```bash
whichtool run ./tools.json \
  --tasks ./whichtool.tasks.yaml \
  --provider ollama --model qwen3:4b \
  --repeat 2 --concurrency 3
```

## The surface

`tools.json` is the `list-search-pair` fixture. `list_users` and `search_users` have
**byte-identical descriptions** — `whichtool inspect` reports that as an error and puts the
pair at the top of its overlap ranking. Nothing in the prose distinguishes them.

## What the model actually did

12 out of 12 on the non-distractor tasks. Zero over-triggering across 6 distractor trials.
A perfectly diagonal confusion matrix. The pair `whichtool inspect` flags as the worst
problem on this surface was **never once confused**.

The model disambiguated from the input schemas: `search_users` requires `query`,
`list_users` offers `limit` and `cursor`. The schemas did the work the descriptions failed
to do.

That is the point of measuring instead of predicting. Lexical overlap said "these two will
be confused"; the model said otherwise. Either finding alone would have been misleading —
`inspect` would have sent you to rewrite descriptions that were not costing you anything,
and `run` alone would not have told you the surface is one schema change away from being
ambiguous.

Neither result is a licence to leave the descriptions identical. It means the current
safety margin rests on the schemas, which is worth knowing before someone "simplifies" them.

## What the run also says about itself

- **2 of 20 trials failed** at the provider and are excluded from every rate, rather than
  counted as the model declining to choose.
- **Thin measurement**, flagged: at `--repeat 2` every tool rests on 2–4 trials, so `100%`
  carries a 95% interval of roughly 34–100%. The report says so instead of letting the
  round number stand on its own.
- **42 minutes** of wall clock for 20 trials. qwen3 is a reasoning model and spends most of
  its tokens thinking, which whichtool never reads. `--dry-run --seconds-per-trial` exists
  because of this.

## Provenance

Produced on 2026-08-17 with qwen3:4b via Ollama 0.32.14, `temperature 0`, `seed 0`,
tool order permuted. It was captured from the repository root against
`./tests/fixtures/servers/list-search-pair.json`, which is why that path — rather than
`./tools.json` — appears on its `target` line. The `tools.json` in this directory is a
byte-identical copy of that fixture, so none of the numbers depend on which path you use.

The file is byte-exact as the tool wrote it, and re-running it costs 42 minutes of local
inference, so it has not been re-rendered since. Three things in it therefore lag the
current build, none of which change a measured value:

- The `surface` line does not carry the tool count; the current renderer writes
  `surface <hash> 4 tools ~449 tokens (estimate)`.
- Long diagnostic subject lists are no longer repeated in the body; the current renderer
  ends them with `about: …`.
- It predates a correction to the position-sensitivity metric, so that section is labelled
  with the older pooled method. The value shown (0%) is identical under both methods here,
  because every scored trial was correct.
