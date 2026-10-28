# EBDA-FUNNEL-11

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-11 — InstaPay due policy: on the due day the subscription goes `past_due` and `next_retry_at = due + INSTAPAY_GRACE_DAYS` (a config constant, default 3, per Ahmad). When that passes unpaid, the store is suspended (`unpaid`), the merchant gets email + bell with the handle, the reference and a wa.me link, and the retry is cleared. Both transitions are compare-and-set, so a double run is a no-op. A recorded payment (manual or card) restores the store at once. Card subscriptions keep the existing dunning (day 0, +3, +7, then downgrade). Cost if wrong: an InstaPay merchant who pays on day 4 is paused for the hours until the super-admin records the payment.
