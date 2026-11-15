# STORE-EDGE-5

> Section: 2026-11-15 - the one purge loss the durable queue does not cover

Ruling STORE-EDGE-5 (2026-11-15) - A purge lost when the isolate is evicted inside the post-response `waitUntil` window (before the first attempt finishes) is not queued; accepted because Cloudflare keeps `waitUntil` work alive on client disconnect and enqueue-first on every catalog write or order batch costs far more than the loss it covers (one extra job run per write). Everything else is covered by STORE-EDGE-4: a purge that fails or is rejected in the request is queued (`storefront-purge-retry`) and dead-letters into the P1 alert. Cost if wrong: one write's page can stay stale up to 6 h (checkout re-reads price and stock, so it cannot charge the old price or oversell). Revisit with an outbox if a lost purge is ever measured.
