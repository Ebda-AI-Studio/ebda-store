# Ruling B1-PLAN-SOT-1 - one source for a store's plan

**Date:** 2026-11-17 (controller + track1, live QA finding B1 on ameliaaurum).

**Rule.** The SUBSCRIPTION (`store_subscriptions.plan_code`) is the single source of a store's plan.

- D1 `stores.plan` is the tier DERIVED from it: written by every plan path (`planService.assignPlan`, billing
  settlement `applyPlan`, lapse/cancel) and repaired daily from the subscription (`reconcilePlanTiers`).
- A Durable Object store's own `plan` and `billing_suspended_reason` are COPIES. The hourly directory reconciler
  (`lib/store-directory-reconcile.ts` `mirrorDrift`) now compares them with D1 and re-pushes D1's value, in both
  directions (a stale lower copy locks paid features, a stale higher copy fails open). The repair drops the cached
  feature map and the public store payloads at once (`repairDoMirror`, NEVER-stale class).
- Entitlement reads go through one resolver (`lib/store-plan.ts` `readStorePlan`, D1 first for a DO store: #847).
- Nobody sets a tier directly: `PUT /admin/stores/:id/plan` takes `{ planCode }` and calls `assignPlan`; a tier body is
  400 `PLAN_CODE_REQUIRED`. `PUT /admin/stores/:id` refuses `plan` (400 `PLAN_VIA_SUBSCRIPTION`).
- Admin Settings and Features show the subscription's plan (name + code) and link to Billing "Assign plan"
  (`#assign-plan`), which lists every plan with code, monthly price and a hidden marker.
- `GET /admin/stores/:id` shows D1's `plan` for a DO store, never the DO copy.

**Evidence.** Prod D1, SELECT only, 2026-11-17: ameliaaurum D1 `plan=enterprise`, subscription `business/active`,
while the admin store read (DO copy) said `professional` and /features resolved Professional. The reconciler compared
only name/nameAr/template/look, so a missed `syncStoreEntitlement` stayed stale indefinitely.

**Cost if wrong:** between a missed sync and the next hourly tick a DO store's features follow a stale tier; with
#847 the entitlement read no longer depends on the copy at all.
