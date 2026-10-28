# EBDA-MONEYA-7

> Section: 2026-10-08 — Money batch A: InstaPay proof, subscription billing fixes (branch `fix/money-a`, EBDA-MONEYA-\*)

Ruling EBDA-MONEYA-7 — InstaPay plan controls (audit M3, CONFIRMED: checkout card-only, change-plan needs a card, cancel/resume hidden without a card): `POST /billing/instapay-plan` records the plan + interval the next InstaPay payment buys in any state (trialing, active, past_due, canceled); the approval applies it. Cancel/resume already worked server-side for InstaPay and are now shown. Card subscriptions keep `changePlan` (`USE_CHANGE_PLAN` 409 otherwise). Evidence: integration "a canceled store can choose a plan, pay by InstaPay and come back". Cost if wrong: an InstaPay merchant who picks a plan and never pays stays on the old one; nothing is charged.
