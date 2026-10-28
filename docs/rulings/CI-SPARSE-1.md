# CI-SPARSE-1

> Section: 2026-10-01 — backlog batch z-ci-other (branch `fix/backlog-z-ci-other`)

**Ruling CI-SPARSE-1 — no workflow uses sparse-checkout, and every self-hosted checkout job
disables an inherited sparse config before it checks out (production deploy failure,
2026-09-30).** The orders PWA deploy failed twice on `ebda-ci6-ebda-store-2` with
`npm ci: no package-lock.json`: `railway-deploy.yml`'s hourly `guest-checkout-probe` checked out
sparse, the persistent self-hosted workspace kept `core.sparseCheckout` in `.git/config`, and the
next job's plain `actions/checkout` reused it — a tree of only `.git` + `scripts/`. Fixed in two
layers: (1) the probe and the new `zap-freshness-check.yml` (which had copied the same pattern
earlier in this batch) now do a full shallow checkout; (2) the shared pre-checkout guard step,
already required before checkout in every self-hosted job by `ci-trufflehog-scratch-guard.test.ts`,
now runs `git sparse-checkout disable` and clears the sparse config when a prior job left one — all
35 copies across 16 workflows. `tests/unit/ci-no-sparse-checkout-leak.test.ts` forbids
`sparse-checkout` in any checkout step, requires the reset in every guard, and runs the guard's own
script against a real repo that reproduces the leak (package-lock.json absent → present).
Mutation-proved: removing the reset reddens 3 tests; re-adding sparse to the probe reddens 1. The same PR's audit caught the class next door: the migration gate ran `node` BEFORE
`setup-node` in the Lint job (exit 127 on the self-hosted runner). `workflow-node-available.test.ts`
now asserts ORDER, not just presence, in every job of every workflow (mutation-proved against the
audited commit). Other
persistent-workspace state found by the sweep: `ai-review.yml` writes a local `git config
user.name/user.email` into the workspace — left as is, since no other job commits from that
workspace and `actions/checkout` does not read identity. Cost if wrong: one extra full-tree write
per job on a workspace that was actually sparse on purpose (none are).
