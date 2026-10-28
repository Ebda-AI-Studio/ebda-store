# WH-9

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling WH-9 (2026-10-21, review I2) — refund events are keyed by the refund's identity (`full`, or the partial's `refundKey`), never by the source event id, and every webhook event id is derived from `storeId:dedupeKey`. The refund stuck-sweep's `notify:false` re-send therefore dedupes to the same event; `notify:false` sources are NOT skipped, because the same flag also marks genuine refunds whose customer notice is suppressed. Cost if wrong: two distinct partial refunds sharing one refundKey would collapse into one webhook.
