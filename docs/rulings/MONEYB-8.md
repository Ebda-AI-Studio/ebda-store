# MONEYB-8

> Section: 2026-10-08 — Money fixes batch B: tax documents, VAT base, COD fee, retention, shipping lifecycle, CSV prices, Egypt addresses (branch `fix/money-b`, MONEYB-\*)

Ruling MONEYB-8 — Declined / out of scope, recorded so they do not read as fixed: (a) building number still required at checkout (Egypt finding 9) — not in this batch's list; (b) InstaPay expiry vs submitted reference (O1), subscription billing M1–M5/B1–B6 and the InstaPay order-confirm flow — batch A; (c) ETA e-invoice submission itself — columns reserved, not built (needs ETA onboarding, tax-research Q1); (d) no in-app "close store" for merchants — deletion stays a super-admin action, now guarded; (e) `/returns` still promises a prepaid return label and final-sale items (no store field backs them) — copy only, no money effect. Cost if wrong: (a) shoppers in informal addresses keep typing a placeholder building number.
