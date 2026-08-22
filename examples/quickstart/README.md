# Quickstart

Everything here runs against files in this directory. Nothing reaches a network until the
last step, and that step is optional.

```bash
cd examples/quickstart
```

## 1. Inspect the surface — free, instant, no API key

```bash
npx whichtool inspect
```

The config in this directory points at `tools.json`, so no target argument is needed. You
should see one error: `list_users` and `search_users` have byte-identical descriptions.

Try the other formats while you are here:

```bash
npx whichtool inspect --format markdown     # a pull-request comment
npx whichtool inspect --format badge        # a shields.io endpoint
npx whichtool inspect --format json | jq .tokens.total
```

## 2. Lint the task set

```bash
npx whichtool tasks lint
```

Ten tasks, three of them distractors, every tool covered. Try breaking it — change an
`expected:` to a tool that does not exist, or delete the distractors — and watch what it
says.

## 3. Find out what a run would cost

```bash
npx whichtool run --dry-run
npx whichtool run --dry-run --seconds-per-trial 50
```

No model is called. The second form estimates wall clock from a figure _you_ measured;
whichtool will not invent one.

## 4. Run it

With a local model, which needs no key and no account:

```bash
ollama pull qwen3:4b
npx whichtool run
```

Or with a hosted one:

```bash
OPENAI_API_KEY=sk-… npx whichtool run --provider openai --model gpt-4.1-mini
```

Save the run so you can do things with it afterwards:

```bash
npx whichtool run --format json --out run.json
npx whichtool report run.json --format html --out report.html
npx whichtool report run.json --format markdown
```

`report.html` is one self-contained file. Open it and click a cell in the confusion matrix.

## 5. See a regression

Edit `tools.json` so the two descriptions are genuinely distinct, run again into a second
file, and compare:

```bash
npx whichtool run --format json --out fixed.json
npx whichtool diff run.json fixed.json
```

`diff` will refuse to compare them if you changed the model or the repeat count between the
two. It matches the same task and trial across runs and uses an exact paired sign test before
calling a movement distinguishable; weak evidence is reported as inconclusive.

## What is in here

| File                    |                                                                              |
| ----------------------- | ---------------------------------------------------------------------------- |
| `tools.json`            | A captured `tools/list` with one deliberate flaw.                            |
| `whichtool.tasks.yaml`  | Ten tasks, three of them plausible in-domain distractors.                    |
| `whichtool.config.json` | Target, tasks, provider and thresholds, so the commands above need no flags. |
