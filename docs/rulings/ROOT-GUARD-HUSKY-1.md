# ROOT-GUARD-HUSKY-1

> Section: Git hygiene (2026-11-23)

**Ruling ROOT-GUARD-HUSKY-1: `.husky/pre-commit` and the new `.husky/pre-merge-commit` call the vendored `scripts/ci/root-checkout-guard.sh` (byte copy of ebda-foundation `os/ops/root-checkout-guard.sh`, PR #164), which refuses a commit or merge commit in this repo's main checkout while it is on main/master.**
Husky points the hooks path at `.husky/_`, so the global `~/.claude/git-hooks` guard never runs here; on 2026-11-23 a failed `cd <worktree> && git merge` ran in this root checkout and moved local main ahead of origin. Fast-forward merges run no pre-merge-commit and stay allowed (`git merge --ff-only origin/main` keeps root current); a ff merge of a local unpushed branch is not catchable at hook time. Escape hatch `FORCEAI_ALLOW_ROOT_COMMIT=1` (logged to `~/Library/Logs/root-commit-guard.log`). Proof: `tests/unit/root-checkout-guard-husky.test.ts` (real git: root main refused, linked worktree allowed, non-ff merge refused, ff allowed, hatch logged). Cost if wrong: a legitimate root commit needs the env hatch; re-sync the vendored copy by hand when the foundation script changes.
