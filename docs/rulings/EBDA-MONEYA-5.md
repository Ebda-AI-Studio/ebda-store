# EBDA-MONEYA-5

> Section: 2026-10-08 — Money batch A: InstaPay proof, subscription billing fixes (branch `fix/money-a`, EBDA-MONEYA-\*)

Ruling EBDA-MONEYA-5 — InstaPay ORDER 48h auto-cancel (audit O1, CONFIRMED in `expireOne`): a submitted receipt FREEZES the hold (`payment_confirmation_expires_at = NULL`) so the sweep never selects it, `expireOne` also skips an order whose payment carries a legacy `customerReference` or a submitted receipt, and `confirm` is allowed past the window when proof was submitted. A merchant rejection restarts the hold at max(original deadline, now + 24 h). An order with NO proof still expires. Not done: re-opening orders that were ALREADY auto-cancelled before this deploy (no reopen path; pre-launch, none expected). Evidence: integration "not auto-cancelled at 48h … can still confirm", "legacy … exempt", "NO proof still expires" (mutation MA-4 red). Cost if wrong: an order whose shopper sent a fake receipt holds its stock until the merchant rejects it.
