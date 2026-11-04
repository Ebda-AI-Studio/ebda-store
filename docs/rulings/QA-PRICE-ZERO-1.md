# QA-PRICE-ZERO-1

> Section: 2026-11-03 - QA store full run, branch `fix/qa-p1-coupon-price-holds`

**Ruling QA-PRICE-ZERO-1 - nothing orderable is free, no coupon is a no-op.** One module, `apps/api/src/lib/sellable-price.ts`, is called by product create/update, bulk price and status, bulk status, CSV import (a free active row fails alone; an explicit variant price of 0 fails), variant create/update and coupon create/update. The error is `400 PRICE_REQUIRED_FOR_ACTIVE` / `COUPON_VALUE_REQUIRED` with `details.messageAr` in Egyptian Arabic (the admin shows it; the coupon form now shows a save error instead of staying silent). Exemptions: draft/archived rows, `pricingMode = gold_rate` rows and variants (priced only by the repricer, Ruling B5-13, so its trigger and writes are untouched), variant products (judged on their variants). A 100% coupon stays allowed (giveaways; our docs tell merchants to use it): percentage 1-100, fixed above 0 and capped at the order subtotal at checkout; only 0, negative and above-100 values are refused. AI edits never write a price; MCP and catalog import reach the products through these services (pinned by a test).

Evidence: QA run 2026-11-03 P1-2 (active Gold Ring at price 0 accepted, 0% coupon saved). Tests: `tests/unit/sellable-price.test.ts`, `tests/unit/sellable-price-services.test.ts`.

Cost if wrong: a merchant who wants a free item uses a 100% coupon (allowed) or a draft, and a legacy active 0-priced row stays orderable until its next edit, because the guard judges writes, not stored rows.
