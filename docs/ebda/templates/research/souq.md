# Souq (general retail & electronics) - reference research 2026-10-14

## Stores studied (screenshots: research folder outside git, `souq/`)

- **B.TECH** (btech.com/ar, custom Next.js, Egypt's main electronics chain; 2B, Noon, Jumia, Amazon.eg, Raya all block headless bots - 403/challenge). Search bar first (black header), delivery-city line under it ("القاهرة"), hero banner, brand-logo rail (Bosch, Beko, Haier, El Araby), 2-col category tiles with cut-outs, product rows with orange round "+" quick-add, wishlist heart, per-card "from X EGP/month with <BNPL>", colour dot, "exclusive" ribbon. PDP: Mylo instalment line + "instalment plans" link, exclusive-instalment banner, "extra 300 EGP off when paying X", colour + capacity selectors, 5-year warranty row, dimensions row, spec table, pickup availability, fixed orange "add to cart" pill. Verdict: the Catalogue look is already this; the commerce rows below are the gap.
- **Mobile Masr** (mobilemasr.com, custom, new + used phones marketplace). Search first, category icon rail, "Pay in instalments" banners, cards with condition badges (new/used, very good/excellent), seller name + verified badge, warranty chip ("ضمان 30 يوم"), share + wishlist, "details" button instead of cart, PDP: inspection report image ("تقرير فحص"), return/shipping policy links, battery health chip, storage/RAM/colour spec rows, fixed add-to-cart above a bottom tab bar (Account/Cart/Categories). Verdict: shows how Egyptians trust electronics - proof and warranty over aesthetics.
- **Nothing** (nothing.tech, Shopify; premium single-brand). Headless capture hit the country modal ("Looks like you're in Kuwait - go to store"); HTML shows Pre-order, Notify Me, Compare, video. Verdict: the Showroom reference - one object per screen, pre-order and notify-me states.

## They have, Ebda lacks

1. Instalment line on cards and PDP ("from 1,2xx EGP/month"; Mylo/valU/Souhoola/Sympl) - MISSING (grep valu/sympl/tabby = 0 in web + schema; PaymentProvider enum has no BNPL).
2. Spec attributes + spec chips on cards (128GB, 8GB RAM) and spec table on PDP - MISSING (Product has `dimensions Json`, `weight`, no attributes/specs field; PDP has no spec section).
3. Compare page - PARTIAL (`app/compare/CompareClient.tsx`, `lib/compare.ts`, toggle in ProductListItem) but without specs the table compares only price/title.
4. Warranty / condition (new/used/refurbished) field and chip - MISSING (no `warranty` in schema; PDP grep 0).
5. Sticky add-to-cart bar on PDP - MISSING.
6. Pre-order and Notify-me when sold out (Nothing) - MISSING (grep preorder/notify/restock = 0; only `allowBackorder`).
7. Deal price with countdown / "exclusive" ribbon - PARTIAL (Promotion + Coupon startsAt/expiresAt, badgeLabel, discountType; no countdown UI).
8. Brand logo rail / brand filter - MISSING (no `brand` on Product; Tag exists and could stand in).
9. Delivery city selector + ETA ("يوصل غدا") - MISSING (ShippingZone/ShippingAreaRate exist; no storefront selector or ETA text).
10. Pickup / branch availability per product - PARTIAL (StoreLocation + /locations; no stock per branch on the storefront).
11. Search-first header and filters - HAVE (`app/search`, `ProductsFilterSidebar`, price range).
12. Quick add, wishlist, bottom tab bar, FBT, recommendations - HAVE.
13. Extra discount with a payment method (e.g. -300 EGP on InstaPay/card) - MISSING (Coupon is code-based, no payment-method scope).
14. Seller / verified badge and device inspection report (Mobile Masr) - MISSING (single-merchant by design; a "report image/PDF" attachment is the cheap part).

## Ebda already ahead

Arabic-first full RTL with sane type, COD/InstaPay, carriers (Bosta/Aramex/Mylerz) plus COD remittance, bundles, loyalty + wallet, one visual editor. B.TECH's mobile header overflows in a narrow window; Mobile Masr is dense and noisy; Nothing needs a country modal. None of them can be restyled by the merchant.

## Phase B platform features (ranked)

1. **Product specs** - key/value attributes per product (ar/en), up to 3 shown as chips on cards, table on PDP, feed the compare page.
2. **Instalment display** - store setting {provider, months, markup%}; render "from X/month" on card + PDP; pure display until a BNPL gateway is added.
3. **Sticky mobile add-to-cart** with price + variant summary.
4. **Warranty + condition fields** (text + chip; "new/used/refurbished").
5. **Notify-me + pre-order** states (email/WhatsApp capture; release date).
6. **Deal ends-at countdown** on product/section from Promotion.expiresAt.
7. **Brand field + brand-logo rail section**.
8. **Delivery city selector with ETA** from ShippingZone.
9. **Payment-method discount rule** on Promotion.

## Look-specific ideas

- Catalogue: spec chips, instalment line, brand rail, search-first (already topology), deal countdown row.
- Night souq: deal countdown in lantern orange, "exclusive" ribbon, brand rail on green.
- Showroom: pre-order/notify-me, spec line under hero product, compare toggle fed by specs, sticky ATC.
