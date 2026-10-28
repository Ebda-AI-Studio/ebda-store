# W-7a

> Section: Backlog batch x-api (2026-10-01, branch `fix/backlog-x-api`)

**Ruling W-7a — the merchant sees an erasure write-off as ONE line on the customer's wallet history
(issue 2126; amends W-7).** The admin ledger flags the entry `forfeitOnErasure` writes
(`erasureWriteOff`), and the card renders "Wallet balance written off after the customer deleted
their account" (EN + AR) instead of the internal note. The audit log stays super-admin only.
Residual: an erased customer who never placed an order has no customer detail page (the lookup
excludes `deletedAt`), so their line is not reachable. Cost if wrong: that population's write-off
is visible only as the store's wallet total dropping.
