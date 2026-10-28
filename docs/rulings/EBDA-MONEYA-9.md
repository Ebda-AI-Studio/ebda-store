# EBDA-MONEYA-9

> Section: 2026-10-08 — Money batch A: InstaPay proof, subscription billing fixes (branch `fix/money-a`, EBDA-MONEYA-\*)

Ruling EBDA-MONEYA-9 — Canceled store (audit 2 #1/#2, B2, CONFIRMED): kept "no new orders while canceled" (`SUBSCRIPTION_REQUIRED`), and fixed what each actor is told: the merchant's bell/email say "new orders are paused, data kept, choose a plan and pay to come back" (not "Free plan limits apply"); the storefront shows a shopper-facing "this store is not taking orders right now"; `chooseInstapay` accepts `canceled` and the plan picker works. DECLINED: allowing Free-plan orders on a canceled store — the free plan is hidden/fallback and not a product offer. B1 (canceling while `unpaid`-suspended keeps the suspension): DECLINED — a canceled store takes no orders either, so the maintenance page is the more honest storefront; paying lifts it. Cost if wrong: a merchant who expected to keep selling on Free must pay or contact support.
