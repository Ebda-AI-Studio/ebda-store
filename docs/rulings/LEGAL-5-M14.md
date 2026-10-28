# LEGAL-5-M14

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling LEGAL-5-M14 — "one ack clears every store" is proven by construction, not by a per-store assertion: notices and acknowledgements are per USER (no store parameter anywhere in `/me/legal-notices`), pinned by `tests/integration/legal-notices.test.ts` (one ack, no notice left) and `LegalNoticeBanner.test.tsx` (re-read on store switch). Cost if wrong: none found; a future store-scoped notice would need its own test.
