# EBDA-FUNNEL-9

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-9 — InstaPay: `store_subscriptions.billing_method = 'instapay'` plus a unique `payment_reference` (`EBD-XXXXXXXX`). The handle comes from `EBDA_INSTAPAY_HANDLE`. When it is unset, InstaPay is not offered and choosing it is refused (fail closed). A merchant's "I paid" claim (`manual_payment_claims`, unique per method + payer reference, at most 3 pending per store) activates NOTHING. Only the super-admin action confirms it. Cost if wrong: a merchant who paid waits for a human to confirm (intended: never auto-activate on the merchant's word).
