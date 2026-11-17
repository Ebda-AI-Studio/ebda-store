# Ruling G35-PRORATE-1 - mid-period plan changes

**Date:** 2026-11-17 (controller; Ahmad: "finish all, nothing loose", choice left open). Register gap G35.

**Rule.** A mid-period UPGRADE takes effect immediately and charges the prorated difference:
`(new total - old total) x remaining days / period days`, VAT included, rounded UP to the piastre. The paid period
keeps its start and end (the renewal then charges the new plan's full price). A DOWNGRADE takes effect at the end of
the paid period: nothing is charged, refunded or credited.

**Details (store, `apps/api/src/services/billing/proration.ts`, the ONE seam).**

- "Total" = what a card is charged for the plan today (`subscriptionChargeAmount`, Ebda VAT applied); the VAT of the
  prorated charge is carved out of it (`vatOfPaidAmount`).
- Days are whole UTC days; a started day counts as remaining. Remaining days are capped at the period's days, so a
  period lengthened by a granted free month never charges more than one full difference.
- An upgrade with no day left charges nothing and is scheduled (the renewal bills the new plan).
- The merchant sees the amount first (`GET /stores/:id/billing/change-plan/quote`); `POST /change-plan` takes
  `expectedAmountMinor` and refuses with 409 `QUOTE_CHANGED` (nothing charged) when today's quote differs.
- A prorated upgrade payment does not count as a "first qualifying paid month" for free-month grants (it is less
  than one month's price; fail closed, `grants.service.firstQualifyingPayment`).
- If the period moved between the quote and the payment (a renewal settled in between) the plan still changes and a
  P1 alert asks an operator to check the difference.

**Scope.** Card change-plan (this PR). Manual payments / InstaPay for a higher plan while a lower one is paid follow
the same rule (follow-up PR after #860, which reworks `recordManualPayment`). Ebda Chat packages keep their own
month-based rule (WA-YEARLY-SWITCH-2, ebda-whatsapp `package-orders.ts`); they do not share this billing service.

**Cost if wrong:** Ahmad prefers credit-to-next-invoice or start-at-period-end -> the rule lives in `proration.ts`
and its callers; one PR to change.
