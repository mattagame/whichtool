## whichtool inspect

`snapshot` · `./examples/ambiguous-server/tools.json` · surface `5086ee475f20` · 8 tools · ~660 tokens *(estimate)*

**1 error, 4 warnings, 1 info.**

- 🔴 `descriptions/identical` `list_issues, search_issues` — `list_issues` and `search_issues` have byte-identical descriptions. Nothing in the text tells the model which one to pick.
- 🟡 `annotations/destructive-name-declared-safe` `deleteIssue` — Tool `deleteIssue` leads with `delete` but declares `destructiveHint: false`, which tells clients to skip the confirmation step.
- 🟡 `annotations/partial-coverage` `issues.comment.add, update_issue` — 6 of 8 tools declare annotations. The rest silently fall back to the defaults, so the surface is inconsistent about what a client should confirm.

<details>
<summary>Context cost — ~660 tokens</summary>

| tool | tokens | share | description | schema |
|---|---|---|---|---|
| `list_issues` | ~130 | 20% | ~25 | ~86 |
| `search_issues` | ~103 | 16% | ~25 | ~58 |
| `close_issue` | ~84 | 13% | ~20 | ~44 |
| `issues.comment.add` | ~77 | 12% | ~10 | ~45 |
| `deleteIssue` | ~71 | 11% | ~21 | ~32 |
| `fetch_issue_details` | ~69 | 10% | ~16 | ~30 |
| `get_issue` | ~64 | 10% | ~13 | ~32 |
| `update_issue` | ~62 | 9% | ~0 | ~47 |

</details>

<details>
<summary>Lexical overlap — 28 pairs scored, 2 notable</summary>

| score | pair | shared terms |
|---|---|---|
| 0.93 | `list_issues` ↔ `search_issues` | **identical description** |
| 0.59 | `fetch_issue_details` ↔ `get_issue` | key, issue |

</details>

<details>
<summary>All findings (6)</summary>

- 🔴 `descriptions/identical` `list_issues, search_issues` — `list_issues` and `search_issues` have byte-identical descriptions. Nothing in the text tells the model which one to pick.
- 🟡 `annotations/destructive-name-declared-safe` `deleteIssue` — Tool `deleteIssue` leads with `delete` but declares `destructiveHint: false`, which tells clients to skip the confirmation step.
- 🟡 `annotations/partial-coverage` `issues.comment.add, update_issue` — 6 of 8 tools declare annotations. The rest silently fall back to the defaults, so the surface is inconsistent about what a client should confirm.
- 🟡 `annotations/read-only-with-mutating-name` `close_issue` — Tool `close_issue` declares `readOnlyHint: true` but its name leads with `close`, which reads as a write. Either the hint or the name is misleading the model.
- 🟡 `descriptions/missing` `update_issue` — Tool `update_issue` has no description. The model has only the name and the schema to go on.
- ⚪ `overlap/notable` `fetch_issue_details, get_issue` — `fetch_issue_details` and `get_issue` overlap at 0.59.

</details>


<sub>Overlap predicts confusion; it does not measure it. `whichtool run` does. **No tool was executed** — whichtool read `tools/list` and stopped there.</sub>
