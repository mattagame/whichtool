# Task sets

The task file is the artifact you commit and evolve. It is what turns "these two
descriptions look similar" into "the model picks the wrong one two times in five".

```yaml
# whichtool.tasks.yaml
version: 1
surface: 'sha256:ab12…' # the surface it was written against; a change is reported, not fatal
tasks:
  - id: users.list.basic
    prompt: 'Show me all the users in the workspace'
    expected: list_users
    tags: [users, read]

  - id: distractor.delete
    prompt: 'Permanently delete the account belonging to Rossi'
    expected: null # a distractor: no tool should be called
    tags: [distractor]
```

Validate it with `whichtool tasks lint`.

## Fields

| Field              | Required | Meaning                                                                             |
| ------------------ | -------- | ----------------------------------------------------------------------------------- |
| `version`          | yes      | Task-set schema version. Currently `1`.                                             |
| `surface`          | no       | The surface hash it was written against. A mismatch is a warning.                   |
| `tasks[].id`       | yes      | Stable identifier. Runs are compared by it, so renaming one breaks that comparison. |
| `tasks[].prompt`   | yes      | Sent to the model verbatim, as a bare user message.                                 |
| `tasks[].expected` | yes      | The tool that should be chosen, or `null` for a distractor.                         |
| `tasks[].tags`     | no       | Free-form labels for `--only` and `--skip`.                                         |

**`expected` has to be written out, even as `null`.** A missing key is an error rather than
a default, because "I forgot" and "no tool should fire here" must never look the same: the
second is the entire basis of the over-trigger rate.

## Distractors are the hard part

A distractor is a task no tool on the server should satisfy. Without them a run cannot
measure over-triggering at all, and a surface tuned only against abstention gets steadily
worse at refusing while the report stays green.

The mistake is making them too easy. "What's the weather in Rome?" against a user-directory
server is a weak distractor: any model refuses it, and the resulting 0% over-trigger rate
means nothing. A strong distractor is plausible _in the domain_ and just outside what the
tools do:

| Weak                           | Strong                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| "What's the weather tomorrow?" | "Permanently delete the account belonging to Rossi"        |
| "Write me a poem"              | "Invite marco@example.com as an editor"                    |
| "What is 2 + 2?"               | "Reset the password for U-4821 and email them the new one" |

Each of the strong ones sits in the server's domain, reads like something the tools might
cover, and is not covered by any of them.

## Three ways to fill one

**By hand.** The most authoritative: you know which requests your users actually make.

**Drafted by a model**, with `whichtool tasks generate`. The result is written to a file for
you to read, edit and commit — it is deliberately not regenerated on each run, because
generation is non-deterministic and execution must not be. A run whose questions changed
under it is not a measurement of anything.

```bash
whichtool tasks generate ./tools.json --provider ollama --model qwen3:4b \
  --tasks-per-tool 3 --distractors 4 --out whichtool.tasks.yaml
```

It refuses to overwrite an existing file without `--force`, and it reports what it dropped:
a task expecting a tool the server does not have usually means a description implies an
operation that is not actually offered — worth knowing on its own.

**Derived**, with `whichtool tasks mutate`. Seeded text transformations, no model:

| Mutation        | What it does                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `typo`          | One or two plausible typing errors: adjacent keys, doubled letters, transpositions. Never a word's first letter. |
| `casual`        | Lowercase, politeness stripped, closing punctuation dropped — how someone types into a chat box.                 |
| `polite`        | The opposite register, padded with courtesy the model has to see past.                                           |
| `imperative`    | A question turned into a command, for the patterns that convert cleanly.                                         |
| `interrogative` | And the reverse.                                                                                                 |

Every variant keeps its original's `expected`, so a variant the model gets wrong is a
**robustness** failure rather than an ambiguity. A mutation that cannot convert a prompt
cleanly skips it and says how many it skipped — half-converting a question would measure the
mutation instead of the surface.

## The YAML whichtool reads

whichtool has no dependencies, so it does not embed a YAML library. It reads a **documented
subset** and refuses everything else with a line number. A refusal is never a silent
misreading, which is the trade this makes.

**Supported**

- Block mappings and block sequences
- Plain, single-quoted and double-quoted scalars, with `\n`, `\t`, `\"`, `\\`, `\uXXXX`
- `null`, `~`, `true`/`false`, integers and floats
- Flow sequences of scalars: `tags: [users, read]`
- Literal (`|`) and folded (`>`) block scalars, with the `-` chomping indicator
- `#` comments, and one leading `---`

Inside a block scalar a `#` and a blank line are **content**, not a comment and not
whitespace, so both survive verbatim into the prompt. In a folded (`>`) block a line break
becomes a space and a blank line becomes a newline, which is what YAML does.

**Refused, by name and with a line number**

- Anchors and aliases (`&name`, `*name`)
- Tags (`!!str`)
- Flow mappings (`{ a: 1 }`)
- Merge keys (`<<`)
- More than one document per file
- Tab indentation
- A more-indented line inside a folded (`>`) block, where YAML keeps it literal. Folding it
  would quietly rewrite the prompt, so it is refused; use `|` instead.

A `.json` task set is always accepted and needs none of this. JSON is detected by shape, so
a `.yaml` file containing JSON loads fine.

## How many tasks

`whichtool tasks lint` will tell you when the answer is "not enough", and `whichtool run`
repeats it against the numbers it actually produced. The rules of thumb it applies:

- Fewer than **3 tasks per tool** and that tool's accuracy carries an interval too wide to
  act on.
- Fewer than **15% distractors** and the over-trigger rate has almost no denominator.
- A tool with **no task at all** means the run says nothing about whether the model can
  find it — which is not the same as the model finding it.

None of this is padding. A run that reports `4/5 = 80%` for a tool has a 95% interval of
roughly 38–96%, which is compatible with almost any conclusion. The report prints the
interval next to the percentage for that reason.

These are Wilson intervals over trials of the prepared tasks in this file. More repeats
measure whether the same routing decisions are stable; they do not add new intents or
estimate performance on unseen ones. Add distinct, reviewed tasks when you need broader
intent coverage.
