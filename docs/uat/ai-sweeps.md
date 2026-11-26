---
feature: ai-sweeps
updated: 2026-05-24
---

# UAT: AI Tools — Bulk Sweeps

**Reviewer account:** see 1Password vault entry `ai-sweeps-uat`  
(store_admin on a test store with ≥10 products, mix of EN-only and bilingual)  
**Pre-conditions:**

- `GOOGLE_GENERATIVE_AI_KEY` set in staging API env (Gemini Flash Lite)
- AI quota counters reset (or quota is not exhausted): `AI_DAILY_REQUEST_CAP` default 1800
- Test store has ≥10 products; ≥3 with missing Arabic names (for translate sweep)
- Preview/staging env only

**Browser matrix:** Chrome latest · Safari latest (sweeps are admin-only; mobile Safari is optional)

---

## Golden path — SEO sweep

1. Admin → AI Tools page
2. Verify 5 sweep types are listed: **SEO**, **AEO**, **GEO**, **Translate**, **Recommendations**
3. Click **SEO** tab/section
4. Verify product list shows with "needs SEO copy" indicator on products missing `seoTitle`/`seoDescription`
5. Verify **Smart-skip default** is ON (toggle reads "Skip products that already have SEO copy")
6. Click **Run SEO Sweep** (smart-skip ON)
7. Verify progress indicator appears; products complete one-by-one (not all-at-once, confirming 2.5s throttle)
8. After completion, verify: products that already had SEO copy were NOT overwritten (smart-skip worked)
9. Navigate to a product detail in admin → SEO tab → verify generated `seoTitle` and `seoDescription` are present and non-empty
10. Open storefront product page in another tab → verify `<title>` and `<meta name="description">` match generated values

## Golden path — Translate sweep

11. Back to AI Tools → **Translate** tab
12. Verify smart-skip shows count of products missing Arabic name/description
13. Click **Run Translate Sweep** (smart-skip ON)
14. After completion, open a product that had no Arabic name → verify `nameAr` and `descriptionAr` are filled
15. On storefront, switch to Arabic locale → verify Arabic product name renders (not empty, not English fallback)

## Golden path — Force-replace checkbox

16. Back to AI Tools → **SEO** tab
17. Check the **Force Replace** checkbox (label: "Overwrite existing copy")
18. Click **Run SEO Sweep**
19. Verify products that previously had SEO copy ARE overwritten (compare before/after)
20. Verify smart-skip toggle is visually inactive/overridden when force-replace is checked (or grayed out)

## Golden path — AEO sweep

21. AEO tab → Run AEO Sweep → verify `aeoContent` or FAQ blocks populated on ≥1 product
22. On storefront product page → verify FAQ/AEO structured data or visible block renders

## Golden path — GEO sweep

23. GEO tab → Run GEO Sweep → verify geo-enriched content (e.g. Egypt-localized description) on ≥1 product

## Golden path — Recommendations sweep

24. Recommendations tab → Run Recommendations Sweep → verify `relatedProductIds` or recommendation block populated
25. On storefront PDP → "You might also like" section renders with ≥1 recommendation

---

## Edge cases

- [ ] **Quota exhausted** — temporarily set `AI_DAILY_REQUEST_CAP=1` in staging → run a sweep → verify sweep stops cleanly with "daily quota reached" message; no unhandled errors; partial results saved
- [ ] **Partial failure (Gemini 503)** — if API returns 503 for one product, per-product retry kicks in (max 3 attempts with backoff); other products continue; final report shows which products failed
- [ ] **Smart-skip with 0 products needing update** — run SEO sweep when all products already have SEO copy → sweep completes immediately with "0 products needed update" message; no API calls made
- [ ] **Force-replace + Arabic locale** — run translate sweep with force-replace ON → existing Arabic translations overwritten; no crash on products where `nameAr` was already set

---

## Sign-off

| Role         | Name             | Date         | Notes                                      |
| ------------ | ---------------- | ------------ | ------------------------------------------ |
| Engineer     | \***\*\_\_\*\*** | **\_\_\_\_** |                                            |
| Merchant rep | \***\*\_\_\*\*** | **\_\_\_\_** | only required before first merchant launch |
