# R-EBDA-COPY-12

> Section: 2026-10-07 — Marketing copy and design (R-EBDA-COPY-\*)

Ruling R-EBDA-COPY-12 — the comparison table lists "3D product models" as included on all three plans. It is not a plan limit in `packages/shared/src/schemas/plan-limits.ts` (nothing gates it), so it is a fixed row in `apps/marketing/src/lib/plans.ts`. Evidence: Ahmad 2026-10-07 via the coordinator. Cost if wrong: if 3D models become plan-gated, the row must read the new limit or it will promise them on Basic.
