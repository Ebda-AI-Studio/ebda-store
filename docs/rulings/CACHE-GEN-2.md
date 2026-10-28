# CACHE-GEN-2

> Section: 2026-10-07 — cache generation counters + fail-closed Node DB role guard (branch `fix/cache-gen-and-role-guard`)

Ruling CACHE-GEN-2 — FIXED on the Node shell: the in-memory L1 was read on every healthy Redis miss, and other replicas' invalidations never reach it (FIX-002, P2; Workers was already fixed by design in 475c5a21). Memory is now read and written only while Redis is down, and a memory write is skipped if a local invalidation moved a covering generation mid-fill. Evidence: removing the healthy-path read gate turns 1 test red (an entry cached during an outage must not be served after Redis recovers). Cost if wrong: during a Redis outage each Node replica caches independently (bounded by the TTL), as before.
