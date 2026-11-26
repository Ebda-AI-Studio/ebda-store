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
- Only an ACTIVE, PAID, still-running period is prorated (money review of #887). The credit is min(catalogue total of the current plan, what was actually paid for this period net of refunds), so a promo or older price never credits more than was paid. A trial or a team-assigned term (nothing paid) pays the new plan's FULL price and a fresh period starts at the payment. An upgrade after the period ended (or while past due) is refused 409 `RENEW_FIRST`: never a zero-charge upgrade.
- One upgrade charge per (subscription, period, target plan) at a time: a second submit while one is pending, or a concurrent one that lost the claim, answers with the first charge's event and charges nothing.
- The merchant sees the amount first (`GET /stores/:id/billing/change-plan/quote`); `POST /change-plan` takes
  `expectedAmountMinor` and refuses with 409 `QUOTE_CHANGED` (nothing charged) when today's quote differs.
- A prorated upgrade payment does not count as a "first qualifying paid month" for free-month grants (it is less
  than one month's price; fail closed, `grants.service.firstQualifyingPayment`).
- If the period moved between the quote and the payment (a renewal settled in between) the plan still changes and a
  P1 alert asks an operator to check the difference.
- **A second upgrade in the same period** (money review of #887): base plus the prorated difference of an earlier upgrade
  INTO the current plan (a succeeded `upgrade` row, `forPeriodEnd` = this period's end, `planCode` = the current plan, no
  refund against it) bought the current plan's whole period, so the next upgrade credits that plan's whole catalogue total.
  Crediting the plain sum (below the total) would charge the first upgrade's missing days again. Residual: a promo base
  followed by two upgrades credits the catalogue total, not the promo (bounded by the plan price difference).

**Scope.** Card change-plan (this PR). Manual payments / InstaPay for a higher plan while a lower one is paid follow
the same rule (follow-up PR after #860, which reworks `recordManualPayment`). Ebda Chat packages keep their own
month-based rule (WA-YEARLY-SWITCH-2, ebda-whatsapp `package-orders.ts`); they do not share this billing service.

**Cost if wrong:** Ahmad prefers credit-to-next-invoice or start-at-period-end -> the rule lives in `proration.ts`
and its callers; one PR to change.
