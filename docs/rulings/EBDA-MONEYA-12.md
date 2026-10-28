# EBDA-MONEYA-12

> Section: 2026-10-08 — Money batch A: InstaPay proof, subscription billing fixes (branch `fix/money-a`, EBDA-MONEYA-\*)

Ruling EBDA-MONEYA-12 — Review notifications (audit 2 #11, CONFIRMED): the merchant gets a bell + email when Ebda confirms (`payment_confirmed`, with the paid-until date) or rejects (`payment_rejected`, with the reason) a subscription payment, and when a billing suspension is lifted (`store_restored`, fired from `restoreFromBilling`); the store gets a push when a shopper submits a receipt (`proof_submitted`). NOT done: a super-admin alert for a new subscription claim (the queue stays poll-only; volume is low pre-launch). Cost if wrong: a claim waits until the super-admin opens /billing-events.
