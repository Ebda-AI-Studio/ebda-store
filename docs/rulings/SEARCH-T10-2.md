# SEARCH-T10-2

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T10-2 — every Workers AI call is time-boxed (`EMBED_TIMEOUT_MS` 15 s per call, binding via a raced timer, REST also via `AbortSignal.timeout`), split into the model's 100-text batches in order, refuses an empty/whitespace text before the call (the model rejects `minLength: 1`; Task 9's doc function returns NULL for those, Task 11 skips them), and checks count, 1024 dims and finite components on every answer. The binding wins when both the binding and the REST pair exist. A REST error carries only the status (`embedding REST 401`, `success=false`), never the body or the token. Query-time callers (Task 12) race their own ~400 ms budget on top (E11). Cost if wrong: a slow-but-successful batch over 15 s fails and is retried by the indexer.
