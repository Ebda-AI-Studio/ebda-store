# EBDA-MONEYA-6

> Section: 2026-10-08 — Money batch A: InstaPay proof, subscription billing fixes (branch `fix/money-a`, EBDA-MONEYA-\*)

Ruling EBDA-MONEYA-6 — Manual-payment period (audit M2, CONFIRMED: the form defaulted to today..+interval and the API wrote it verbatim): the server now owns the default — period start = max(now, trial end while trialing, current period end while active/past_due), `manualPeriodFor`; the admin form sends no dates unless the operator explicitly overrides BOTH. The tier switches when the payment is approved, so an early payer for a DIFFERENT plan gets it at once while the paid time still starts at the current end: an upgrader gets the higher tier for the rest of the current period free, a downgrader loses the higher tier for it. Accepted. Evidence: unit "period rule" (mutation MA-3 red), integration "Ebda's approval does, from the trial end". Cost if wrong: up to one period of the upgrade price difference per early upgrade.
