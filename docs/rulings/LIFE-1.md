# LIFE-1

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

- Ruling LIFE-1 - the growth strategy's email 6 ("day 13, no card") is NOT built. Evidence: `billing/reminders.service.ts` already emails every trialing store at 7, 3, 1 and 0 days before `trialEndsAt` (kinds d7, d3, d1, d0, one row per kind in `billing_reminders`), and the d1/d0 copy carries the card / InstaPay instructions. The strategy's "trial-ending reminder is missing" was wrong: only the recap with the recovered-cart number was missing, built as `trial_recap` at trial end - 4 days so it never lands on the same day as d3. Cost if wrong: if the d1 mail turns out not to say "the store needs a payment method to stay live", a merchant on day 13 gets one email instead of two; add a `payment_method_missing` kind then.
