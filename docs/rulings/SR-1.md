# SR-1

> Section: 2026-09-16

**Ruling SR-1 — `getStoreById()` keeps its `null`-on-any-failure contract.**
Its siblings `fetchStoreByDomain`/`fetchStoreBySlug` now split 404 (miss) from
everything else (transient); `getStoreById` does not. All 5 of its references
are the definition, its import in a test, and 3 test assertions — it has zero
production callers and sits on no shopper's 404 path, and its existing
`503 → null` assertion in `store-resolve-logging.test.ts` is a deliberate
regression gate. Cost if wrong: a future admin surface that adopts it inherits
the transient-as-miss bug — mitigated by a doc comment at its definition
telling the next caller to split it first.
