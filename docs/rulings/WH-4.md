# WH-4

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling WH-4 (2026-10-21) — `order.paid` fires only when the order is already `paid` at the moment `order/created` is announced (online payment, wallet); a cash-on-delivery order is followed through `order.status_changed`. Cost if wrong: COD merchants expecting `order.paid` on collection get nothing.
