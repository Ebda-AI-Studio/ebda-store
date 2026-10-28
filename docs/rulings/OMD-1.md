# OMD-1

> Section: 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

**Ruling OMD-1 — a difference between the refund recorded on the return and the
allocation re-computed by the GL moves the sales-return debit, never cash or
tax.** The credit is the amount actually refunded; the tax share stays the
pro-rata share the sale booked for those lines, so the revenue line absorbs the
difference (warn-logged). On the code as it stands the two can differ only
when two returns' events are processed out of order (AP-5b(4)), by a fils or
so; no path lets a merchant type a partial refund amount. Cost if wrong: an
accountant who wants such differences in a separate fee/other-income account
reclasses them by hand.
