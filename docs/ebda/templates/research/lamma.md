# Lamma (home food & home kitchens) - reference research 2026-10-14

Honest limits: Egyptian food/grocery leaders are app-first or bot-blocked. Breadfast's website is a landing page that pushes the app (no web shop); Talabat's web home is an app-download page; Instashop is Cloudflare-blocked; Gourmet Egypt (Magento) returned HTTP 405 to Chrome (curl HTML only); Mandarine's hero is a dark video preloader that never rendered in headless. Findings from those come from HTML text, not screenshots. No home-kitchen Instagram shop with a real web shop was found live.

## Stores studied (screenshots: research folder outside git, `lamma/`)

- **Breadfast** (breadfast.com, WordPress landing): "supermarket in your pocket", same-day delivery, scheduled delivery asset, app badges. Verdict: proves Egyptian habit is app/WhatsApp ordering; a web shop must feel app-like (tap +, cart bar, reorder).
- **Talabat Egypt** (talabat.com/egypt, Next.js): area/landmark search first ("Let's go"), then categories; free delivery and delivery-time promises in copy. Verdict: location-first entry, not catalogue-first.
- **Gourmet Egypt** (gourmetegypt.com, Magento grocery): "Same Day Delivery", reorder, gift cards, newsletter in HTML. Screenshot blocked.
- **Mandarine Koueider** (mandarinekoueider.com/en, Next.js, Egyptian sweets since 1928): cinematic video hero, heritage line, "Discover collection" CTA, English-first. Verdict: video + heritage sells trust; the shop below the fold not captured.
- **Milk Bar** (milkbarstore.com, Shopify; global): round category icon rail (birthday / new / best sellers / cakes), "Shop best sellers" cards with "Get the details" CTA, 3 trust icons (one-of-a-kind, packaged, nationwide), "Send group gifts - ship to multiple addresses", gift card with design + send date + message, Q&A, UGC "moments", cookie bar.

## They have, Ebda lacks

1. Delivery time promise and slot picker (today / tomorrow / 2-4 PM; Breadfast scheduled, Gourmet same-day, Talabat minutes) - MISSING (ShippingZone has only `estimatedDays*`; grep slot/scheduled/deliveryDate = 0).
2. Lead time / prep time per dish ("يتجهز في 24 ساعة") and pre-order date chips - MISSING (grep preorder/leadTime/prep = 0; only `allowBackorder`).
3. Reorder / "اطلب تاني" row for returning customers (Gourmet reorder, Breadfast habit) - MISSING (no reorder in account or storefront).
4. Minimum order per zone + progress ("أضف 80 ج.م للحد الأدنى") - PARTIAL (`minOrderAmount` exists on Coupon/Promotion only; ShippingZone has `freeShippingThreshold`, no minimum).
5. Sold-by-weight / unit pricing (per kg, per piece, dozen) - MISSING (Product has `weight`, no unit label or step quantity).
6. Dish modifiers / add-ons (extra cheese, no onions, note per item) - MISSING (options are single-choice variants; no multi-select with price delta; no per-item note).
7. Sticky cart bar with total and item count - PARTIAL/MISSING (BottomTabBar only; no sticky total bar found).
8. "+" stepper on cards - PARTIAL (`quantityInCart` prop in ProductCardCta; verify stepper UI per template).
9. Gift message + send date + multiple addresses (Milk Bar) - MISSING (grep giftMessage = 0; only order-level `customerNotes`; one address per order).
10. Gift cards - MISSING (no model).
11. Order via WhatsApp - PARTIAL (`wa-token` hydrator and WhatsApp in StoreContext; no "order this dish on WhatsApp" button confirmed).
12. Maker / kitchen profile strip with story - PARTIAL (brand-story, image-text sections; no maker profile section with photo + hygiene info).
13. Category icon rail on home - HAVE (`category-grid`, CategoryStrip).
14. Cash on delivery and carriers - HAVE (COD fee, Bosta/Aramex/Mylerz).
15. Video hero - MISSING (same as Qamar).

## Ebda already ahead

Real Arabic copy and RTL (Talabat/Breadfast web pages are English-first marketing), COD with fee handling, bundles ("طقم سفرة"), loyalty/wallet, AI product descriptions, a merchant-editable page builder. Competitors' shops are apps the merchant cannot restyle.

## Phase B platform features (ranked)

1. **Delivery slots + cut-off**: store setting (days ahead, windows, daily capacity, cut-off hour), picked at checkout, stored on Order, shown in admin.
2. **Lead time / pre-order**: per product `leadHours`, cart computes earliest date; date chips (غدًا، الجمعة).
3. **Reorder row** ("اطلب تاني") from last orders in account and on home for returning customers.
4. **Per-zone minimum order** with cart progress; combine with free-shipping progress.
5. **Item modifiers and note**: multi-select add-ons with price delta + free-text note on cart line.
6. **Unit pricing**: unit label (كجم/قطعة/دستة), quantity step (0.5), price per unit.
7. **Sticky cart bar** (count + total + checkout).
8. **Gift message + send date**, then gift cards.
9. **Maker profile section**.

## Look-specific ideas

- Family table: delivery-time chip tied to slots, menu tabs with portion variants, big "+" and modifiers, reorder row.
- Kitchen notebook: maker profile first, pre-order date chips, lead-time chips on dishes, gift message.
- Fresh market: reorder row, unit pricing per kg, minimum-order progress, sticky cart bar with total, category icon rail (Milk Bar style).
