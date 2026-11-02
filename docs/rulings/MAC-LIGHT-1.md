# MAC-LIGHT-1

> Section: Mac-light dev loop (2026-11-02, branch `chore/mac-light-prepush-gate`)

Ruling MAC-LIGHT-1 - The Mac only edits code; GitHub-hosted CI is the gate. The pre-push hook keeps the action-pin check, gitleaks on the pushed range and prettier on the changed files (seconds), and drops local lint, typecheck, prisma generate, shared-package builds, `vitest related` and the full-gate fallback. The AI review and blast-radius steps are untouched. Evidence: Ahmad 2026-11-02; supersedes the local-suite parts of PREPUSH-1 and PREPUSH-2 (the planner stays in `scripts/ci/pre-push-plan.mjs` but the hook no longer calls it). Cost if wrong: a type or lint error is caught by CI on the PR instead of at push, one round trip later.
