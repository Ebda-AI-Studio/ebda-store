# R1016-REFUND-DAYS

> Section: 2026-10-16 — review of `fix/ahmad-decisions-1016` (R1016-\*)

Ruling R1016-REFUND-DAYS — every shopper-facing refund timeframe reads "5–10 business days" in ar and en across email and SMS ("٥–١٠ أيام عمل" is the same range). Before this the Arabic email said 5–10, the English email 1–3 and the SMS 3–5, so a shopper's channel changed the promise. 5–10 is the conservative end (card and bank settlement), pinned by `tests/unit/refund-days-same-range.test.ts`. A new refund text reuses the range or changes all four together. Cost if wrong: if a provider settles faster, shoppers wait up to the stated window and never longer than promised; if we ever settle slower than 10 days, every text understates and this ruling must be revised.
