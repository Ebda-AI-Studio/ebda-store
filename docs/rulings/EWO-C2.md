# EWO-C2

> Section: Cluster C — order summaries + tax display

**Ruling EWO-C2 — the order e-mails follow the same placement (closed in the same batch).**
`order-confirmation.ts` (order-created + payment-success e-mails, en + ar) now takes its tax row and
an "Incl. VAT / شامل ضريبة القيمة المضافة" caption after Total from `orderTaxPlacement`;
`OrderEmailData` carries `taxIncludedInPrice`, passed by `order-created.ts` and
`order-status-changed.ts` (both load the full order row via `include`). Pinned by
`tests/unit/order-confirmation-email-tax.test.ts` (2 red with the placement input dropped).
Exclusive-tax e-mails are byte-for-byte unchanged. Cost if wrong: none for existing orders — every
row has `taxIncludedInPrice=false` and 0 inclusive rates are active.
