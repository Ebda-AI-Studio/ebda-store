# EBDA-FUNNEL-5

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-5 — Server-enforced go-live gate `assertStoreMayGoLive` (`services/billing/go-live-gate.ts`), called from `OnboardingService.goLive`, the only merchant writer of `stores.status = active`. It passes for: a granted plan or `comped`; an unexpired trial with a saved card or with InstaPay chosen; an `active` subscription paid by card or by a recorded manual payment; an additional store riding the oldest store's multi-store plan. The store must also be within the owner's allowance. Super-admin status writes (`PATCH /admin/stores/:id/status`, `PATCH /stores/:id/status`) are the operator override and are not gated. Cost if wrong: an operator can still publish an unpaid store by hand (intended).
