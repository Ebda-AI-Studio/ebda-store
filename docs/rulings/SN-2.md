# SN-2

> Section: 2026-09-25 — Sentry open-issues sweep (branch `fix/sentry-open-issues`)

**Ruling SN-2 — EBDA-API-28 (cart P2003 `cart_items_cart_id_fkey`) needs no new change.** All 3
events are 2026-08-31 16:15-16:53 UTC; #1108 (2dd34917, 19:56 UTC the same day) moved addItem onto
the ambient tenant transaction, and the issue has no event since. Cost if wrong: a first add-to-cart
500 would reappear and re-open the issue on its own.
