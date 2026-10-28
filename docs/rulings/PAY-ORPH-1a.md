# PAY-ORPH-1a

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling PAY-ORPH-1a — the orphaned-invoice alert covers the failed Payment-row WRITE, for every
caller (issue 2370; widens PAY-ORPH-1 from "failed COMMIT" to "no durable Payment row").**
`PaymentService.createPayment` calls the gateway and then writes the Payment row; both
`POST /payments/create` and the MCP `place_order` tool armed their alert only after `createPayment`
RESOLVED, so a throw from `prisma.payment.create` after the gateway said yes (statement timeout,
connection blip, the tenant transaction's timeout expiring during the gateway call) left a live
invoice with no row and raised nothing. The post-gateway writes are now wrapped inside
`createPayment`: on a throw it logs and raises the P1 (`payment.create.orphaned_invoice.record`)
and rethrows. Because it lives in `createPayment`, the admin payment link, the WhatsApp payment link
and the failed-payment retry are covered too (they had no orphan alert at all). The callers' catch
remains the COMMIT-failure net; the two cannot both fire for one invoice, since the callers arm
theirs only after `createPayment` resolves. Still no void call (no provider adapter has one).
Pinned by `tests/unit/payment-create-orphaned-record.test.ts` (mutation-proven). Cost if wrong: an
operator who misses the P1 leaves an invoice payable with nothing recorded.
