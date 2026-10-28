# BS-2

> Section: 2026-10-01 — backlog batch b-services (branch `fix/backlog-b-services`)

**Ruling BS-2 — issue 1705: the currency sweep covers every order-money surface a customer or the
merchant's accountant receives (invoice, confirmation / payment / refund emails, the two admin
alert emails); the remaining `/1000 + toFixed(3)` sites are left EGP-only on purpose.** Those are:
the XLSX exports (`order.routes.ts`, `customers.routes.ts` — their headers say "(EGP)"), the bank
reconciliation narrations (the GL's base currency is EGP by design), the coupon / minimum-order
error strings, the loyalty ledger description, the abandoned-cart and payment-link WhatsApp copy,
`shipping.routes.ts`, `product-feed.ts` and `onesignal.service.ts`. EGP emails render
byte-identically (`emailMoney` keeps the old "X.XXX EGP" / "X.XXX د.ك" form for EGP). Cost if
wrong: a store selling in a non-EGP currency sees 3-decimal "/1000" figures in its spreadsheet
exports and a few merchant-facing messages until they get the same treatment.
