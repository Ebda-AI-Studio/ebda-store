# AUDIT-12

> Section: 2026-10-07 — AUDIT-P2P3 (FIX-011..015, branch `fix/audit-p2-p3`)

Ruling AUDIT-12 — FIXED (docs only): the AI Product Feed (`agent_feed`) and Agent Checkout (`agent_checkout`) were documented as individually-priced add-ons sold outside any plan, but `packages/shared/src/plan-baselines.ts` puts both in the paid baseline (AI-first policy, 2026-07-21). Code is the source of truth, so `docs/business/02-feature-catalog.md`, `04-pricing-tiers.md`, `06-faq.md` and `plan-feature-matrix.md` now say "included in every paid plan; off on `free`; a super-admin can restrict a store". Original 2026-07-13 plan docs under `docs/plans/` are left as history. Cost if wrong: a sales conversation quotes the feed as free when the owner later decides to price it separately; the baseline would then need to change first.
