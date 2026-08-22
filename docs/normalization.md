# Surface normalization

Every command starts by putting the served `tools/list` into a canonical form. This note
records the decisions that were not obvious, because each one is a trade-off and the
reasoning is easier to review than to re-derive.

## Two schema views, on purpose

A normalized tool carries the input schema twice:

| Field                 | Form                                                     | Used by                |
| --------------------- | -------------------------------------------------------- | ---------------------- |
| `inputSchema`         | canonical key order, `$ref` left intact                  | token counting         |
| `inputSchemaResolved` | internal `$ref`s inlined, `$defs`/`definitions` stripped | analysis, surface hash |

The reason is that the two consumers want opposite things.

Token counting has to reflect what the server actually sends. A schema that factors a
repeated sub-schema into `$defs` costs a genuinely different number of tokens from one that
repeats it inline — fewer once the shared sub-schema is large enough to pay for the `$defs`
block and the `$ref` pointers, more when it is not. Either way, inlining before counting
would report a cost the surface never pays.

Analysis wants the opposite. "How many required parameters does this tool have" should not
depend on whether the maintainer used `$defs`, and neither should the surface hash — a
`$defs` refactor changes no semantics, so it must not invalidate a committed task set.

`tests/hash.test.ts` pins both halves of this.

## What the hash covers

`computeSurfaceHash` hashes the canonical JSON of, per tool: `name`, `title`,
`description`, `inputSchemaResolved`, `outputSchemaResolved`, `annotations` — sorted by
name.

Excluded, and why:

- `_meta` — transport and implementation bookkeeping. Not part of what a model reads.
- `originalIndex` — list order is neutralised by the trial planner (SPEC §5.4), so it must
  not version the surface.

The prefix is part of the value: a hash is always `sha256:<64 hex>`, never a bare digest,
so the algorithm is never ambiguous.

## Description normalization is deliberately conservative

Applied: Unicode NFC, CRLF and CR to LF, trailing horizontal whitespace stripped per line,
runs of three or more newlines collapsed to two, outer trim.

Not applied: collapsing interior runs of spaces. Descriptions carry indented markdown, and
collapsing would both mangle it and push the token count away from what the server sends.
The rule is: normalise the churn that carries no information, and leave everything else.

## Array order

Arrays keep their order, with one exception. `required` is a set in JSON Schema, so
reordering it means nothing and is sorted before hashing.

`enum` is explicitly _not_ sorted. Its order is visible to the model and can influence what
the model produces, so a reordering is a real change to the surface.

## Refs that cannot be inlined

An external `$ref`, a cyclic one, or a dangling pointer is left exactly as it was and
reported as a diagnostic. In that case `$defs` is kept too — removing the target of a ref
that survived would produce a schema strictly worse than the original.

Inlining is bounded by a node budget. A `$ref` graph that expands past it stops early,
reports `surface/unresolved-ref-too-large`, and analysis proceeds on the partially resolved
schema rather than hanging.

## Malformed entries do not take the surface down

A tool with no usable `name`, a duplicate name, or an entry that is not an object is
skipped with one diagnostic each, and the rest of the surface still loads. A broken entry
should cost you that entry, not the whole inspection.
