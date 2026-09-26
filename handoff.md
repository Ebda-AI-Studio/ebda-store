# Handoff — RLS strict-policy contextless reads

_Updated 2026-09-25. Branch `fix/rls-strict-policy-contextless-reads`, worktree
`_worktrees/force-website-builder__fix-rls-strict-policy-contextless-reads`, off `origin/main` @ `4b710e6c`._

## Goal

Fix the defect class behind the 2026-09-25 RLS cutover rollback (public store payloads lost their
FAQs/how-tos under `force_app`) and add the gate that would have caught it. Production stays on the
owner role; nothing here flips it.

## Current state

Code, tests, CI job and docs committed; PR open (not merged). Details + remaining risks:
`docs/plans/2026-07-02-rls-cutover.md` § "2026-09-25 — first Phase 3 attempt"; rulings RLS-S1…S5 in
`docs/RULINGS.md`.

## Done

- 24 STRICT-policy tables enumerated from a migrated scratch Postgres; every contextless reader fixed
  (public store resolve, AI recommendations, admin FAQ/how-to CRUD, `$transaction` GUC inheritance,
  checkout backorder insert, 12 bulk-AI jobs, insights narration, R2 orphan check).
- `scripts/rls-payload-parity.mjs` + CI job "RLS Payload Parity (owner vs force_app)": fails on main
  (8/111), passes on the branch (111/111).
- Integration: `tests/integration/public-store-faqs-rls.test.ts` (fails on main, passes here);
  force_app tests for strict reads, transaction inheritance, `runInStoreScope`, strict-table registry.

## In progress

Nothing.

## Left to do

- Merge after CI is green, then run the parity script against a restored production copy.
- Phase 2 staging soak for the admin/Inngest paths the parity gate does not drive (list in the plan).
