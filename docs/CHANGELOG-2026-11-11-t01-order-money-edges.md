# 2026-11-11 - T01 order money edges

- S3-X6 (Ruling T01-SHIP-1): a failed shipping lookup refuses checkout / admin manual orders with `SHIPPING_UNAVAILABLE` (503) instead of booking 0 shipping. Admin override still works.
- S3-O10 (Ruling T01-CANCEL-1): shoppers cancel their own pending, unpaid COD order from the account order page (`POST /public/orders/:id/cancel`). Route table manifest updated.
- S3-O7 (Ruling T01-COD-1): COD stays paid on Delivered / Mark paid (MONEYB-7); courier remittance import is report-only by design, now pinned by a test. (superseded by S3-O7 in #735: a matching courier statement line pays a delivered order)
