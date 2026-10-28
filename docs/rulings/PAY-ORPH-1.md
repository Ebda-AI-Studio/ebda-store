# PAY-ORPH-1

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling PAY-ORPH-1 — a gateway invoice whose Payment row died with a failed COMMIT is alerted,
not voided (issue 2360).** The compensating rollback stays armed until the payment wrap commits
(issue 2306), so a failed COMMIT after the provider ACCEPTED rolls the order back while the invoice
stays live — MyFatoorah can notify the customer directly, and a paid invoice's webhook then
matches no Payment row and is rejected. No provider adapter has a void/cancel call, and none was
guessed: POST /payments/create and the MCP `place_order` tool now record the accepted invoice and,
if the wrap then fails, log it and raise a P1 (`payment.create.orphaned_invoice.*`) naming the
provider, the gateway transaction id and the order, for an operator to void in the provider
dashboard. The admin payment-link and retry paths are the same shape without a rollback (their
order is untouched); a failed COMMIT there already surfaces as the request's 500/503 +
`COMMIT_TIMEOUT` P1, not as this alert. Cost if wrong: an operator who misses the P1 leaves an
invoice payable with nothing recorded, until a provider void entry point exists.
