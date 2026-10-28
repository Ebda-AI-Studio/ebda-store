# AP-5b

> Section: 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

**Ruling AP-5b — accepted residuals of the line cancel.** (1) Shipping income is
never reversed by line cancels, as with partial returns: cancelling every line
one by one leaves exactly the shipping charge booked against cash (pinned by a
test); a whole-order cancel is the path that reverses it. (2) The adjustment
credits the sale's cash account, as a partial return does, but `cancelBackorder`
does not itself refund the provider — the merchant refunds the line off-platform
(or via the order's refund action). (3) The fanout's "Refund issued" notification
now fires only when `paymentStatus === 'paid'`, and states the line's allocated
amount instead of the order total. (4) As with returns, two cancels whose events
are processed out of order can each count the other as prior; the rounding
remainder can then land 1 fil off. Cost if wrong: a merchant with shipping on a
fully-cancelled backorder order sees shipping income remain until they cancel
the order; a line cancelled but never refunded at the provider shows cash lower
than the gateway balance.
AMENDED 2026-10-01 (issue 2275): the admin no longer says otherwise. The cancel
button reads "Cancel line & reverse the sale" (was "Cancel & Refund"), the modal
states up front that no money is sent, the reason label no longer claims it is
"sent to customer" (it lands only in the order event and the journal memo), and
`cancelBackorder` returns `owedToCustomer` (the allocated `cashCredit` when the
order was paid, else 0) so the modal names the sum the merchant must still refund
at the provider. (3) is unchanged: the customer's "Refund issued" email still
fires at cancel, before the merchant's off-platform refund. Cost if wrong: a
customer is told a refund was issued a little before the merchant actually sends
it — the admin now tells the merchant to.
