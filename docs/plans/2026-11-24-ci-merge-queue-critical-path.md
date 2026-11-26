# CI: shorten the merge-queue critical path, skip heavy jobs for a docs-only group (plan)

Date 2026-11-24 (Ahmad approved speeding up the merge pipeline). Files: `.github/workflows/ci.yml`, `scripts/ci/mq-scope.mjs`, `scripts/ci/merge-queue-gate.mjs`, `scripts/ci/shard-lines.sh`.

## Measured (merge_group run 45333918584, success, 31.7 min)

Build 10.9 min; Unit shards 13-16 min (from 0.5); Worker dry-run (marketing) 10.7 min; then, only AFTER Build (at 11.3): Integration Tests 19.9 min, Builder E2E 18.5 min, E2E 2.0, Orphan 1.1. Critical path = Build + Integration = 31.3 min.

## Finding

None of those four jobs consumes anything Build produced: no `download-artifact`, each runs its own `npm ci`, `db:generate`, `build -w packages/database|shared`. Their `needs: [build]` was ordering only (and, for Integration, `needs.build.result == 'success'`).

## Change

1. Integration, E2E, Builder E2E and Orphan coverage depend on `tested-tree` instead of `build` and carry the same condition Build had (`event != pull_request`, tested-tree skip != true, heavy != false). They now start with the unit shards. Build still runs and the gate still requires it.
2. Integration Tests and Builder E2E run as 2 shards each: vitest `--shard` on the parallel integration pass, `scripts/ci/shard-lines.sh` splits the serial planner lane by file (disjoint, complete, tested); Playwright `--shard` for Builder E2E. Expected: the longest chain becomes about the unit shards (16 min) instead of 31; target merge_group run <= ~20 min.
3. Docs-only skip: `mq-scope.mjs` already skipped the heavy-only jobs for docs and light-workspace groups (MQ-SCOPE-1). New: a STRICT `docs_only` output (every file under docs/ or a `.md`, none on a rail; one other file, an empty diff or the `ci:full` label = not docs-only) that also skips the workerd dry-run, and the gate accepts that skip ONLY when heavy=false and docs_only=true. A light-workspace group (e.g. marketing) still runs its dry-run.

## Check names

The branch rulesets require only `Repo guards`, `API Worker boots on workerd` and `Merge queue gate` (read from the rulesets). Job ids are unchanged and the gate still lists them; the shard jobs have matrix names (`Integration Tests (shard 1/2)`, `Builder E2E (...) shard 1/2`), which the drain's required-check derivation skips by design.

## Cost / risk

- Concurrency: a full merge group now runs ~16 jobs at once (was staggered); the org is on the Free plan (20 concurrent jobs) and the queue builds up to 4 groups, so jobs may queue under load. If that bites, drop one shard count (SHARDS is a single number per job).
- A failing Build no longer stops the parallel heavy jobs early (they spend minutes before the gate fails); the gate result is the same.
- Rollback: revert the PR; no data or config outside the workflow and three scripts.
- Not measured: the new run time (needs the first merge group after merge); flaky-test behaviour of a sharded Integration run.
