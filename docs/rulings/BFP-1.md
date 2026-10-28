# BFP-1

> Section: 2026-09-25 — buy-flow parity harness (`scripts/buy-flow-parity/`)

**Ruling BFP-1: background Inngest functions are EXECUTED by a local executor.
They are not only recorded.** Restock and coupon reversal on cancel
(`order/refunded`) and webhook processing (`payment/webhook.received`) run as
Inngest functions. A harness that only recorded events reported a cancelled COD
order as `vase=2, coupon usage 1` (nothing returned), while the executed run
shows `vase=4, usage 0`. The executor gives each step one attempt and has no
concurrency or idempotency windows, and it applies these limits identically to
both refs. Cost if wrong: a defect that only appears on an Inngest RETRY is not
compared.
