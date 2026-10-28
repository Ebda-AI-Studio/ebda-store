# EBDA-FUNNEL-14

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-14 — Upsell: every plan 402 carries `details.upgradeTo` (the cheapest public plan that satisfies the refused limit, `upgradePlanFor` in `@ebda/shared`) and `messageAr`/`messageEn`. Plan-gated features (`merchant_mcp`, `remove_branding`, `abandoned_cart`) now answer 402 `PLAN_LIMIT_REACHED` instead of 403 `FEATURE_DISABLED` when the PLAN withholds them; a merchant toggle that is off still answers 403. The admin api client localizes any code that carries both messages and raises an upsell dialog that links to the plan page. Cost if wrong: a client that matched 403 for a plan-gated feature now sees 402.
