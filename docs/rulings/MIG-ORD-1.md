# MIG-ORD-1

> Section: 2026-10-01 — backlog batch z-ci-other (branch `fix/backlog-z-ci-other`)

**Ruling MIG-ORD-1 — a new migration folder must sort strictly after main's newest, and no two
folders may share a 14-digit timestamp; enforced in CI, with the two existing production collisions
grandfathered by exact folder set.** Prisma orders migrations by folder name and production has
already applied main's newest, so a back-dated or same-stamp folder runs in a different order on a
fresh database (CI, restore, new branch) than it did in production. The live case: open PR #2311
adds `20261001120000_payment_config_key_fingerprint` while main has
`20261001120000_backorder_line_stock_taken` — `scripts/check-migration-order.mjs` reports it (exit 1)
when run in that PR's worktree. The gate runs as the first step of CI's required `Lint` job (no
`needs`, runs on every PR) against a freshly fetched `origin/main`, and fails closed (exit 2) when it
cannot read main. `20260615000000_*` (5 folders) and `20260925160000_*` (2) are already applied in
production and cannot be renamed — the folder name is the key in `_prisma_migrations` — so they are
allow-listed by exact set; a new folder joining either timestamp still fails, and a unit test fails
if the list and the on-disk collisions ever disagree. **The fetch never goes shallow outside GitHub Actions (2026-09-30, twice).** The first version of the
CI step ran a bare `git fetch --depth=1 origin +refs/heads/main:...`. Run by hand or by an agent in
the shared developer repo — all worktrees share one `.git` — it wrote `.git/shallow` at origin/main's
current tip (no reflog entry, because the ref did not move), and every worktree's merge then failed
with "unrelated histories" (17:30 at 0e59048b, 19:10 at 925b9f76). The fetch now lives inside the
script (`--fetch`); `fetchArgs` adds `--depth=1` only when `CI=true` and `GITHUB_ACTIONS=true`, and
`migration-order-gate.test.ts` proves a local run leaves a full clone full (with a positive control
that the Actions env does go shallow) and forbids a bare shallow `git fetch` in any workflow, script
or hook. **Post-merge arm (issue 2355):** on a push to `main` the same step runs with
`--base ${{ github.event.before }}` (the pre-push tip, fetched by sha), so the just-merged folders
are the added set; the PR-time arm alone printed "clean" on every push because `origin/main` was the
pushed commit. Which arm catches what: the PR arm stops a back-dated or same-stamp folder before
merge; the push arm catches the two-open-PRs race (both passed against the same old main) after the
second merge, as a red `main`. It DETECTS, it does not prevent: `railway-deploy.yml` runs on the
same push and `migrate deploy` is the Railway pre-deploy command, so the folder is usually applied in
production by the time the red check lands — the remedy is then to confirm the two migrations are
order-independent and record the pair (a rename is no longer possible), not to rename. Residual:
prevention needs "require branches to be up to date" in branch protection, a repo setting, not code. Cost if wrong: one PR a month renames a folder it did not need to.
