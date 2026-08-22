<!--
Anything that changes behaviour should have an issue first - see CONTRIBUTING.md.
Typos, broken links and misleading error messages need no issue; send them.
-->

## What this changes

<!-- What was wrong, and why this is the right fix. The diff already says what moved. -->

Closes #

## How it was verified

<!-- The command you ran and what it produced. "Tests pass" on its own is not verification. -->

- [ ] `bun test`
- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run format:check`
- [ ] `bun run build`

## If a golden test or an example capture moved

<!--
Those diffs are the point of committing them. Say what changed in the output and why the
new bytes are correct - not just that they were regenerated.
-->

- [ ] Not applicable
- [ ] The diff is explained above

## Checklist

- [ ] New behaviour has a test; a fix has a test that failed before it
- [ ] Conventional commit messages, and no `Co-Authored-By` trailers
- [ ] No tool on the server under test is ever executed
- [ ] Nothing new in `src/core/` reaches for Bun, `node:` or `process.*`
- [ ] Anything printed to the terminal is still pure ASCII
- [ ] No new runtime dependency (open an issue first if one is genuinely needed)
- [ ] `SPEC.md`, `README.md` **and** `README.it.md` updated if behaviour changed
