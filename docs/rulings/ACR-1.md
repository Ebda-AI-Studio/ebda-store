# ACR-1

> Section: Backlog batch x-api (2026-10-01, branch `fix/backlog-x-api`)

**Ruling ACR-1 — the abandoned-cart recovery link is removed; the report stays (issue 2035).**
Reminders link to the store's plain `/cart`; the unused public `…/cart/recover/:id` endpoint is
deleted. The report keeps its counts. **Amended by ACR-1a below:** the recovery figures were first
set to `null` on the premise that nothing attributes an order — that premise was false. Cost if
wrong: a shopper opening a reminder on a new device sees an empty cart and must re-add items.
