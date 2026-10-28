# LEGAL-6

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling LEGAL-6 — legal notice emails are bilingual, Arabic first (`dir="rtl"` block, then `dir="ltr"` English block, subject built from `BRAND.product.nameAr`/`nameEn`), for every recipient regardless of `users.language`: the legacy column default `'en'` makes the stored value unreliable for a legal notice. Evidence: `tests/unit/legal-notice-email.test.ts` (both blocks, Arabic first), `tests/integration/legal-notice-fanout.test.ts` (`language='en'` gets the same payload). Cost if wrong: a longer email.
