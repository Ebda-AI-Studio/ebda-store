# Qamar (fashion & boutiques) - reference research 2026-10-14

## Stores studied (screenshots: research folder outside git, `qamar/`)

- **Joomah** (joomahabaya.com, Shopify Dawn, Egypt abaya) - done earlier: hero video, Size x Length chips, personalisation field, pickup line.
- **Mamzi** (mamzistore.com, Shopify, Egyptian designer label priced in EGP) - editorial, premium: slow hero slider, horizontal product rails, press logos (Vogue/ELLE), heritage story band. PDP: colour swatches shown as product thumbnails, size text chips, "1 in stock" urgency bar, Google Pay express button, "Pickup available at <branch>, ready in 24 hours". Verdict: best tone reference for Atelier.
- **Dress Code** (dresscodeme.com, Shopify "Nimbus", Egyptian hijabi-friendly DTC) - dense, UGC-style on-model photos, per-category carousels with a play icon (video on cards), "+" quick-add on cards, announcement bar (free shipping over 1300 EGP, code DC30, Sympl split), PDP: crossed price + "Save LE 150" chip, BNPL line ("5 payments of 105 EGP, 0 interest"), SKU, "Low stock: 6 left" bar, colour swatches as photos, S-M / L-XL set sizes, trust icons row (14-day return). Verdict: closest to what Egyptian shoppers expect; Lookbook/Vitrine territory.
- **Alamal Shop** (alamalshop.com, WooCommerce, Giza abaya/kaftan) - cluttered but conversion-heavy: per-card colour dots + size chips, FEATURED/HOT badges, "Quick View", wishlist heart, bottom tab bar (Shop/Categories/Search), COD and 14-day return copy. Verdict: shows the colour-dot + size-chip card Egyptians already read.
- **Everlane** (everlane.com, Shopify; global ref - COS/Zara/Arket/Reformation all block headless bots) - full-bleed single-image hero, nearly no chrome, one CTA, thin announcement bar. Only fold captured (others timed out).

## They have, Ebda lacks

1. Hero video / on-model motion (Joomah, Dress Code cards) - MISSING (hero slides are images; no video field, `registry.ts` hero slide).
2. Size chart / fit info (Joomah nav, abaya length) - MISSING (grep `size.?guide` = 0).
3. Two-axis option chips with price/stock per combo (Size x Length) - PARTIAL (ProductOption/Variant exist in schema.prisma; PDP uses "pills", no chip grid for 2 axes, no per-axis out-of-stock strike).
4. Colour swatches (dot on card, photo thumbnail on PDP) - MISSING (`ProductOptionValue` has value/valueAr only, no hex or image; no swatch grep hits).
5. Personalisation / note per item (Joomah) - MISSING (only order-level `customerNotes`).
6. BNPL / instalment line (Dress Code Sympl, ValU/Sympl/Tabby are normal in Egypt/Gulf) - MISSING (grep valu/sympl/tabby = 0 in web/schema; PaymentProvider enum has no BNPL).
7. Low-stock urgency bar on PDP (Mamzi, Dress Code) - PARTIAL (`lowStockThreshold` on Product; no PDP rendering found).
8. Free-shipping progress ("add 300 EGP for free shipping") - PARTIAL (`freeShippingThreshold` per zone shown on /shipping and checkout; no cart/header progress).
9. Pickup / branch availability on PDP (Mamzi, Joomah) - PARTIAL (`StoreLocation` + /locations page + footer branches; not on PDP).
10. Crossed price + "Save X" chip - HAVE (compareAtPrice, discountType; `discount-badge.ts`).
11. Quick-add "+" on cards, wishlist heart, bottom tab bar - HAVE (ProductCardCta, BottomTabBar, WishlistItem).
12. Sticky add-to-cart bar on PDP mobile - MISSING.
13. Press/"as seen in" logo strip - MISSING (trust-strip/badges exist but are icon+text; no logo-row section).
14. Shop-the-look / outfit bundles - PARTIAL (Bundle model + FrequentlyBoughtTogether; no look-with-hotspots section; Lookbook look has the idea only).

## Ebda already ahead

Arabic-first RTL and Egyptian payments (COD, InstaPay badges in trust-badges), bundles, FBT, loyalty, wallet, promotions engine (firstOrderOnly, minOrderAmount, scopes), shipping carriers (Bosta/Aramex/Mylerz), abandoned-cart recovery. Reference stores: English-first, Dress Code and Alamal are cluttered, Mamzi PDP hides Arabic entirely and shows 3-decimal EGP.

## Phase B platform features (ranked)

1. **Swatches + option-value images** - add `hex`/`imageId` to ProductOptionValue; render dot on card, photo thumb on PDP.
2. **Size chart** - per store/category table (rows x cols, ar/en), PDP link + nav slot.
3. **Hero/section video** - mp4/webm + poster, muted loop, reduced-motion -> poster, 3 MB cap, mobile crop.
4. **Two-axis chip grid with per-combo stock** (strike OOS combos).
5. **BNPL line** - configurable "or 4 payments of X" text from provider (Sympl/ValU/Tabby) once checkout supports it.
6. **PDP low-stock bar + sticky ATC + pickup line** - read lowStockThreshold, StoreLocation.
7. **Cart free-shipping progress bar.**
8. **Per-item personalisation text** carried to OrderItem + admin.
9. **Press-logos section; shop-the-look section** (image with product pins).

## Look-specific ideas

- Atelier: Mamzi/Everlane restraint - video hero optional, size chart in nav, press strip, no badges.
- Lookbook: shop-the-look pins, UGC photo strip (Dress Code style), card video play icon, swatches.
- Vitrine: occasion tiles + swatch-on-card (Alamal dot pattern), BNPL line, countdown on promos.
