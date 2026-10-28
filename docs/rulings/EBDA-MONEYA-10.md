# EBDA-MONEYA-10

> Section: 2026-10-08 — Money batch A: InstaPay proof, subscription billing fixes (branch `fix/money-a`, EBDA-MONEYA-\*)

Ruling EBDA-MONEYA-10 — Trial-end order blackout (audit 2 #3, CONFIRMED: status flips only in the 04:00 UTC job): `assertOrderAllowed` decides at order time with `ordersOpenFor` — a trial that ended stays open when a card is on file (charge pending) or InstaPay is chosen (grace), closed only with no payment method (the job will cancel). Evidence: unit "orders at trial end are decided at order time". Cost if wrong: an InstaPay store that never pays takes orders for up to the 3-day grace plus one job cycle, as a `past_due` store already did.
