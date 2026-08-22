# A deliberately ambiguous MCP server

`tools.json` is a captured `tools/list` from a plausible project-tracker server. Every
schema in it is valid. A client will load it without complaining. A model will still pick
the wrong tool, and this example shows why.

Run it yourself, from this directory:

```bash
whichtool inspect ./tools.json
```

`report.txt`, `report.json` and `report.md` are committed output, captured from the
repository root so the target line reads the same for everyone:

```bash
whichtool inspect ./examples/ambiguous-server/tools.json --out examples/ambiguous-server/report.txt
whichtool inspect ./examples/ambiguous-server/tools.json --format json --out examples/ambiguous-server/report.json
whichtool inspect ./examples/ambiguous-server/tools.json --format markdown --out examples/ambiguous-server/report.md
```

That keeps the example honest: if the tool's behaviour changes, the diff shows up here.
They are listed in `.prettierignore`, because a reformatted capture is no longer a capture.

## What is wrong with it

| Tool                                 | Problem                                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_issues`, `search_issues`       | Byte-identical descriptions. Only the schema separates them, and the model reads the description first.                                                           |
| `get_issue`, `fetch_issue_details`   | Two names for one read, differing only in the parameter name (`issueKey` versus `key`).                                                                           |
| `close_issue`                        | Declares `readOnlyHint: true` while its name leads with `close`. Either the hint or the name is lying to the client.                                              |
| `deleteIssue`                        | Declares `destructiveHint: false` on a tool that deletes an issue and its attachments. That tells a client to skip the confirmation step.                         |
| `deleteIssue`, `issues.comment.add`  | Three naming conventions on one surface: `snake_case`, `camelCase`, `dotted.path`. No lexical metric catches this, which is precisely why `whichtool run` exists. |
| `update_issue`                       | No description at all. The model has the name and the schema and nothing else.                                                                                    |
| `issues.comment.add`, `update_issue` | No annotations, while six of the eight tools have them. Partial coverage is worse than none: the surface is inconsistent about what a client should confirm.      |

## What `inspect` cannot tell you

`inspect` reports that `list_issues` and `search_issues` are lexically indistinguishable.
It does **not** report how often a model actually picks the wrong one, or which way round
the confusion runs, or whether the inconsistent naming costs anything at all.

That is `whichtool run`. The gap is the point of the project: static analysis predicts
confusion, and only a model in the loop measures it — and the two disagree more often than
you would expect. [ollama-qwen3](../ollama-qwen3) is a real run on a surface whose worst
lexical problem cost the model nothing at all.
