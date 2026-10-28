# EBDA-FUNNEL-3

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-3 — The chosen plan lives in `store_subscriptions.pending_plan_code` + `billing_interval` while the subscription is `trialing` on `growth`. The existing trial-end charge already bills `pendingPlanCode ?? planCode` at `billingInterval`, so the trial-end job needed no new charge path. Evidence: happy-path integration test (Basic yearly chosen → charged Basic yearly). Cost if wrong: a UI that reads `pendingPlanCode` as "scheduled downgrade" mislabels the trial (the billing page labels it "chosen plan" while trialing).
