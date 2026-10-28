# CL-8

> Section: 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

**Ruling CL-8 — a provider-PAID answer on an order that already left `pending`
is its own outcome with its own P1, not a skip (issue 2134, issue 2136,
issue 2137, issue 2143).** Only `INVALID_STATUS_TRANSITION` is terminal in the
auto-cancel reconcile; every other error, 4xx included, rethrows (a skipped
4xx would leave the order `pending` and re-skip it nightly). The stale confirm
is counted as `staleConfirmed`, pages `order.auto_cancel.captured_on_terminal_order`
naming order/payment/transaction ids, and writes a `reconciliation` payment
event so the order page shows it. NOT done: automatically refunding or
re-opening the order — whether captured money on a staff-cancelled order is
refunded or the order revived is a merchant decision (Ruling R2-5 already
defers the adjacent #1948 question). `payment-webhook-process` keeps its
4xx-class terminal rule: there a 4xx means the inbound bytes are bad, and it
already persists a `rejected` webhook row with a replay UI. Cost if wrong:
none silent — the worst case is a P1 per affected order per nightly run until
a human acts; the order is no longer `pending`, so it is reported once.
