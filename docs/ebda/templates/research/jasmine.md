# Jasmine (beauty & skincare) - reference research 2026-10-14

Honest limit: I could not find a live Egyptian/Gulf skincare DTC store that loads headless (Tdawi, Sephora ME, Nefertari domains blocked/unknown; Aesop, Ordinary-style sites hit Cloudflare). Meraki turned out to be an Egyptian stationery brand, kept as a "Bloom"-tone reference only.

## Stores studied (screenshots: research folder outside git, `jasmine/`)

- **Nice One** (niceonesa.com/ar, Saudi beauty retailer, custom platform, Arabic default) - dense retail: black header + search, brand-banner rail (Maybelline, Anua, MAC, The Ordinary), per-card star rating + review count, -% chip, countdown badge on flash deals, wishlist heart, price with old price, Tabby/Tamara in HTML, loyalty. Verdict: shows what Gulf/Egyptian beauty shoppers scan for - brand, rating, discount - too loud for Ebda's "calm" bar.
- **Meraki Egypt** (merakieg.com, Shopify, EGP, Cairo stationery): pink drenched palette, countdown timer + "save up to 100 EGP" in the announcement bar, bundle upsell, FAQ accordion, product rails per category. Verdict: proves a blush/pink Egyptian store reads as local and warm (Bloom).
- **Glossier** (glossier.com, Shopify; global ref): media-first hero with a single CTA. PDP: model-photo gallery with how-to/before-after frames, rating stars (7,143), "Best seller" tag, shade swatch tiles, Afterpay line, 4 benefit keywords (Thickening / Conditioning / Cruelty Free), "Show more" description, ingredients accordion, "Save with sets" bundles with save %, subscribe-and-save, reviews.
- **The Ordinary / Summer Fridays / Rhode** probed (Shopify/SFCC, video present) but not screenshotted; only Glossier used for detailed findings.

## They have, Ebda lacks

1. Shade swatches (Glossier tiles, shade dot on cards) - MISSING (`ProductOptionValue` has value/valueAr only; no hex/image).
2. Ingredients / key actives block + "how to use" - MISSING (grep ingredient = 0; Product has description/excerpt only, `ProductFaq` exists).
3. Skin-type / concern filter and tags ("بشرة دهنية", "حب الشباب") - PARTIAL (Tag/ProductTag + filter sidebar exist; no typed concern/skin-type facet or home chips wired to them).
4. Star rating + count on cards - PARTIAL (Review model + ReviewSection + structured data; card display not found in templates).
5. Review photos / verified-buyer filter - PARTIAL (`verifiedPurchase` HAVE; no image upload on Review).
6. Key-benefit icons row (4 words) - MISSING (trust-badges is store-level, not per product).
7. "Save with sets" bundle box on PDP with save % - PARTIAL (Bundle + BundleItem + /bundles/[slug] + FrequentlyBoughtTogether; no "% saved" box on the product page).
8. Subscribe & save / refill reminder - MISSING (grep subscription/recurring = 0 in schema).
9. Routine builder (cleanse -> treat -> protect) as bundle - PARTIAL (bundles can express it; no step labels).
10. BNPL line (Tabby/Tamara/valU) - MISSING.
11. Flash-deal countdown - PARTIAL (Promotion.startsAt/expiresAt; no countdown UI).
12. Sample / minis, gift cards (Glossier gift card, Nice One gift) - MISSING (no gift-card model).
13. Expiry / PAO / batch info (important for Egyptian pharmacy-style trust) - MISSING.
14. Authenticity badge ("100% original") - PARTIAL (trust-badges section can say it).

## Ebda already ahead

Arabic-first with Arabic skincare vocabulary built into looks, COD/InstaPay, bundles + FBT + loyalty + wallet, AI product copy (BulkAiJob, AEO descriptions), ProductFaq with schema. Nice One and Meraki are noisy; Glossier has no Arabic.

## Phase B platform features (ranked)

1. **Swatch option type** (hex or image) with shade name under the tile.
2. **Product facts block**: ingredients (ar/en), key actives chips (%), how-to-use, PAO/expiry, skin-type + concern tags; same fields drive filters and compare.
3. **Card rating** (stars + count) from Review aggregate.
4. **Concern/skin-type facet** wired to home chips and PLP filter.
5. **PDP "save with sets"** box using Bundle (shows % saved).
6. **Review photos** (R2 upload, moderation reuse spamScore).
7. **Subscribe & save** (interval, discount; Phase C billing).
8. **BNPL line**, **gift card** product type.

## Look-specific ideas

- Apothecary: ingredients-first hero, ingredient chips on cards, PAO/expiry line, ritual story band.
- Bloom: swatch dots on cards (page colour = product colour), review photo strip, announcement countdown + bundle-saving (Meraki).
- Clinic: concern tiles + skin-type filter, 3-step routine bundle with step labels, active % chips, Glossier-style benefit row.
