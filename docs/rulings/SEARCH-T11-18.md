# SEARCH-T11-18

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T11-18 (accepted residual, Task 11 re-review) — a TEMPORARY quarantine is never upgraded to permanent: a product that fails retryably twice in every attempt is re-admitted after 24 h, tried again (one batch call plus at most two single calls), and re-quarantined for another 24 h, indefinitely, with one summary P1 per cycle (it counts as new after expiry). Evidence: SEARCH-T11-15's rule needs a non-retryable error for a permanent quarantine, and a provider that answers a specific input with retryable errors forever is not a known failure mode of Workers AI (`EmbeddingError` maps 429/5xx/timeouts/binding throws to retryable). Cost if wrong: about three Workers AI calls and one P1 per such product per day (bge-m3 $0.0118/M input tokens: well under $0.001/day per product); an operator can stop the cycle by fixing the text or deleting the product.
