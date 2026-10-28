# BF-1

> Section: Backlog batch final (2026-10-01, branch `fix/backlog-final`)

**Ruling BF-1 — audit and blast-radius inputs diff from the merge base (issues 2338, 2352).**
`scoped-audit.yml` handed `scripts/scoped-audit.sh` a two-dot `base..head`, so a PR behind main was
audited against a direct two-commit diff: 204 of 214 files on PR 2331 were main's own later
commits, presented as the PR deleting them. The workflow now passes `base...head` (the script
already kept that intact, #1763). The same class was live in `blast-radius.sh`, which split any
range on `..` into two positional refs — it now passes the range through as one argument, and
`blast-radius.yml` passes three dots. `ci.yml`'s two `git diff --name-only "$BASE_SHA" HEAD`
filters were left: on a PR the checkout is the merge commit, so that diff IS the PR's change, and
an over-inclusive list only runs more jobs. Cost if wrong: a three-dot diff omits main's own
commits — reviewed on their own PRs — so a semantic conflict between a stale branch and newer main
is caught by CI on the merge commit, not by this audit.
