# BS-8

> Section: 2026-10-01 — backlog batch b-services (branch `fix/backlog-b-services`)

**Ruling BS-8 — issues 2274 / 2276 / 2277 amend AP-5.** (a) 2276: the claim + `backorder_line_cancelled`
marker now run on the request's transaction when there is one (`hasTenantContext()`), so they commit
or roll back with the deferred `order/refunded` send; a rolled-back request leaves the line open
(integration-tested), which removes the need for a recovery sweep. (b) 2274: a zero allocation is
posted but never notifies, and the consumer reads a partial's `refundAmount` with `??`, so 0 can no
longer become the order total. (c) 2277 is NOT fixed: the "none was reserved" claim was false for
non-variant lines and is corrected in code and `inventory-model.md`; whether the cancel should heal
the negative backorder debt (restore all unfulfilled units, only the negative portion, or nothing)
is a stock semantics decision left to the owner on the issue. Cost if wrong: until decided, a
non-variant product whose backorder line is cancelled keeps a negative on-hand that reads out of
stock and disagrees with account 1200.
