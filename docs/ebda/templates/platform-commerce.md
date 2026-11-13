# Platform commerce features (Phase B0)

Eleven things shipped on `feat/phase-b-qamar` before any Qamar work: swatches, a struck-out Size x Length grid, product facts, lead time with a "delivers by" chip (and a store-wide fallback), per-item personalisation, sticky mobile bars, video upload, hero video, size charts and the receipt-printer success page. Plan: `docs/plans/done/2026-10-14-phase-b0-platform-commerce.md`. Rulings: `docs/RULINGS.md` (B0-\*, T5-\*, T9-\*). Research rows: `docs/ebda/templates/research/SUMMARY.md` (1-5, 7, 8).

Rules that apply to all of them:

- **Platform code, never per store.** Every feature is data-driven and renders nothing until a merchant enters data (no empty states, no placeholders). No new `StoreTheme` toggle was added (the ThemeTab ceiling is 7).
- **Bilingual.** Each merchant field has an `Ar` twin. The active language wins; the other is the fallback, never a blank. Exception: a CONTROL label (the personalisation field's label, and the same label inside the checkout's "add your personalisation" error) never borrows the other language; an empty active-language label reads as the platform default "Personalisation" / "التخصيص" (F4: "الاسم للتطريز" inside an English sentence, with bidi-flipped quotes).
- **Taste bar (B0-4).** On a card: at most 5 swatch dots (then `+N`) and at most 2 fact chips, below the price, and nothing else. One accent colour (the primary action). Motion in exactly three places: the receipt print, the sticky bar slide-in, the swatch crossfade, each with a reduced-motion end state.
- **Two PDP paths.** `apps/web/src/app/products/[slug]/ProductDetailClient.tsx` (default skins) and `apps/web/src/templates/dahab/ProductDetail.tsx`. **Card paths = the 4 core card paths + Dahab (`ProductCard` + `ProductCarousel`) + the 4 hand-built mappers.** The 4 core: `StorefrontProductCard`, `templates/base/ProductCard.tsx` (the shared card Qamar, Souq, Jasmine and Lamma render), `shared/ProductCarousel.tsx`, `app/products/ProductListItem.tsx`. (The five Force skin cards were deleted; Ruling SKIN-DEL-1.) Dahab: `templates/dahab/ProductCard.tsx` (which `dahab/ProductCarousel.tsx` renders). The 4 hand-built mappers are card paths too: `YouMightAlsoLike`, `CartRecommendations`, `FrequentlyBoughtTogether`, `WishlistClient`; they map through `templates/adapters.ts` (C-01: real `variants` and stock, never a hard-coded in-stock).
- **Cache class.** Every one of these reads rides the public product caches and is BOUNDED-stale (the PDP revalidates in 60 s, listings and recommendations in at most 5 minutes). Every write goes through `invalidateStoreProductCaches`, so a save shows within seconds on the storefront.
- **Migrations** (all additive): `20261016000100_option_value_swatches`, `20261016000300_product_facts`, `20261016000400_product_lead_time`, `20261016000500_personalisation`, `20261016000900_size_charts`, `20261016001000_order_item_variant_name_ar`. Video, hero video, the sticky bars, the receipt and `deliveryDays` need none. `20261016000500_personalisation` swaps the `cart_items` unique indexes (ACCESS EXCLUSIVE on `cart_items`), so its lock is brief on a table that is empty in production. None of the B0 migrations sets a `lock_timeout` (B0-50, per `docs/DB-INDEX-MIGRATIONS.md`): a timeout would leave the migration FAILED and block later deploys until a manual `migrate resolve`.
- **PDP fold (390 px phone, B0-49).** The fold is gallery, title, price and the first option selector; add-to-cart is always reachable through the sticky bar (`StickyAddToCart`, and Dahab's pinned bar, both via `useAnchorOffscreen`), shown from first paint whenever the main button is off-screen in either direction and hidden while it is visible. Both fixed-bottom bars lift by `--bottom-tab-h` (the tab bar's own height var) plus the safe-area inset. Order below the fold: personalisation, add to cart, delivery chip. The default PDP's category chip and description sit BELOW the buy block (with the facts), and the merchant badge row renders only when a badge exists. Dahab caps its phone gallery at `max-h-[52svh]` (B0-40; `object-cover` crops as before, desktop unchanged). Measured on the seeded Linen Abaya (3 option axes + a required personalisation): the add-to-cart button's top sits at y=1090 (Minimal) and y=1139 (Dahab) on an 844 px viewport, which is why the sticky bar carries the action there.

## 1. Swatches (colour dots and photos on option values)

**What.** An option value (for example Colour = Rose) can carry a hex colour and/or a fabric photo. The storefront draws a round swatch for it instead of a text chip. A value with neither stays a text chip; there is never an empty circle. An image wins over the hex.

**Where the merchant edits it.**

- Admin → Products → a product → **Variants** (`/stores/[id]/products/[productId]/variants`). One option: per-row colour (`ColorField`) and photo on `SimpleVariantsForm`. Two or more options: the **Swatches** editor (`OptionSwatchesEditor`), with every value of every option and its own Save. Clearing a field sends `null`. A failed save names which values failed ("Color: Rose"), not a count.
- API: `PUT /stores/:storeId/products/:productId/option-values/:valueId`, and the option and option-value create routes (`POST .../options`, `POST .../options/:optionId/values`), accept `swatchHex` and `swatchImageUrl` (`createOptionSchema`, `createOptionValueSchema`, `updateOptionValueSchema`).

**Where it renders.**

- Edges: a card dot carries `border-foreground/35` and an unpicked PDP circle `ring-foreground/35`, so a black swatch stays visible on an ink skin like Dahab (F7, WCAG 1.4.11 non-text contrast).
- PDP, both paths: the selector in `components/VariantSelector.tsx` (32 px round button, 44 px hit area, ring on the picked one, the picked value named beside the axis label, the localised name as `aria-label`). A colour tap crossfades the gallery image over 200 ms (ease-out-quint, reduced motion: instant, never on first paint).
- Cards: `SwatchDots` on the 8 card paths + Dahab + the 4 hand-built mappers. Decorative (`aria-hidden`), at most 5 dots and then `+N`. `N` counts every swatch value, not only the shipped ones (`_count.values`).
- Dahab's own `appearance='swatch'` / `swatchColor` is untouched; a product that has swatch values uses the round swatch even under Dahab.

**Data.** `ProductOptionValue.swatchHex` (`#RRGGBB`, DB CHECK and `swatchHexSchema`), `ProductOptionValue.swatchImageUrl` (https only, at most 2048 characters, B0-8). Public PDP payload: each option value ships `id`, `swatchHex`, `swatchImageUrl`. Listings carry them through `LISTING_SWATCH_OPTIONS_SELECT` (`apps/api/src/lib/listing-swatch-select.ts`: up to 3 options and 8 swatch-bearing values each), also used by the recommendation and wishlist selects. The R2 registry lists `ProductOptionValue.swatchImageUrl`, so the orphan sweep keeps swatch photos.

**Limits.** 5 dots on a card. Hex must be six digits. Image URL must be https. Bulk re-import keeps swatches and Arabic option labels by `name|value` (B0-36); a value renamed in the sheet loses its swatch.

**Rulings.** B0-8 (https only), B0-11 (the four hand-built lists carry dots), B0-12 (the thumbnail rule), B0-36.

## 2. Size x Length strike-out (the two-axis chip grid)

**What.** On a product with two or more option axes (Size and Length, say), a combination with no stock is shown struck through and cannot be picked, instead of silently hiding. The existing per-combination stock logic is untouched; B0 added the strike styling and the swatch-aware selector.

**Where it renders.** The same `VariantSelector` on both PDPs. A sold-out text chip is disabled with `line-through` and reduced opacity. A sold-out swatch gets a diagonal slash and an `aria-label` of "<name>, Sold out" / "<name>, نفدت الكمية". The Dahab snapshot (`tests/fixtures/builder/__snapshots__/dahab-pdp.html`) carries the same `line-through`.

**Thumbnail rule (B0-12).** A value chip shows an image only when every variant carrying that value has the same non-null image; otherwise a multi-axis product would show one variant's photo on its "S" and "52" chips. Swatches cover the per-colour case.

**Limits.** Display only: availability comes from variant stock (`effectiveInventory`, `docs/architecture/inventory-model.md`). Where the merchant edits it: nowhere new (the variant stock grid).

**Rulings.** B0-12.

## 3. Product facts (key-value attributes)

**What.** Bilingual name/value rows ("Fabric: Linen", "Care: Hand wash") a merchant can add to a product. Up to two can be pinned to the product card; all of them show in a table on the PDP and in the compare page.

**Where the merchant edits it.** Admin → Products → a product → **Edit** (`/stores/[id]/products/[productId]/edit`) → the **Product details** card (`FactsCard`, after the inventory block). Rows can be added, reordered and deleted; a per-row translate button fills an empty language side through `/ai/translate`. While a translation is in flight, move up / move down / remove are locked (the result is written back by row index). The new-product form has no facts card (edit only).

**Where it renders.**

- Cards: `FactChips` under the price (value only, no key, `text-xs`: nothing under 12 px, F5) on the 8 card paths + Dahab + the 4 hand-built mappers. `tests/unit/commerce-no-arbitrary-text.test.ts` keeps every `components/commerce/*.tsx` free of arbitrary `text-[…]` utilities.
- PDP: `FactsTable`, below the buy box on the default PDP (after SKU, to keep the 390 px fold), and as a closed "تفاصيل المنتج / Product details" accordion on Dahab.
- Compare: `lib/compare-facts.ts` merges rows by the exact (English, Arabic) name pair; `CompareClient` renders them. A compare list saved before B0 shows no fact rows until the product is re-added (B0-14).

**Data.** `Product.facts` JSONB, `NOT NULL DEFAULT '[]'`, DB CHECK `jsonb_typeof = 'array'`. Each row: `{ key, keyAr, value, valueAr, onCard }`.

**Limits.** At most 24 rows (`PRODUCT_FACTS_MAX`), at most 2 with `onCard` (`PRODUCT_FACTS_ON_CARD_MAX`), name 40 characters, value 120, and a row needs a name and a value in at least one language. 25 rows or 3 card rows is a 400.

**Rulings.** B0-4, B0-14. The bulk sheet does not carry facts (B0-36).

## 4. Lead time and the "delivers by" chip

**What.** A merchant can mark a product as made to order (`leadTimeDays`). The PDP then shows when the order is expected, computed from the store's delivery estimate plus the lead time: "يوصلك بين الأربعاء 21 أكتوبر والسبت 24 أكتوبر" and, for made-to-order, one muted line "بيتجهز خصيصًا لك في 5 أيام".

**Where the merchant edits it.** Admin → Products → a product → **Edit** → **FulfilmentCard** (lead time, 0-60 days, empty = none; the size guide picker sits in the same card). The store-wide fallback is section 11.

**Where it renders.** `DeliveryChip` on both PDPs: under the buy buttons on the default PDP, under the button row on Dahab. It is hidden when there is no usable estimate, never "0 days" or "NaN". Not on cards (B0-4).

**How the date is computed.** `deliveryWindow` (`packages/shared/src/commerce/delivery-window.ts`): the fastest active zone with estimates (`estimatedDaysMin`/`Max`, else `estimatedDays`), else the store-wide fallback; plus `leadTimeDays`. BUSINESS days, skipping the store's days with no delivery (`settings.deliveryOffDays`, Friday by default; B0-1a superseded by B0-48; section 12), in the store timezone (default `Africa/Cairo`), stepping calendar days across the DST switch. Zones come from `GET /stores/public/:id/shipping`, cached per store per session. Dates use the new `day` preset of `formatDate` ("Wed 21 Oct" / "الأربعاء 21 أكتوبر").

**Data.** `Product.leadTimeDays Int?` with a DB CHECK 0..60 (`lead_time_days`). Public payload ships it through `STOREFRONT_PRODUCT_SELECT`.

**Limits.** 0-60. Two lines only when `leadTimeDays > 0` (B0-15). No date picker in B0: delivery slots already exist as checkout delivery windows (`settings.checkoutDelivery`, `checkout/_lib/deliveryWindows.ts`); a date picker is deferred to Lamma (B0-1).

**Rulings.** B0-1, B0-1a, B0-15, B0-16, B0-17.

## 5. Per-item personalisation (name, engraving, note)

**What.** A product can ask the shopper for one short text (name for embroidery, letters to engrave, a note). Two units of the same product and variant with different text are two cart lines and two order lines; the same text merges into one line. The text travels to the order, the invoice, the confirmation email and the admin.

**Where the merchant edits it.** Admin → Products → a product → **Edit** → the **Personalisation** card (`PersonalisationCard`, "تخصيص القطعة", after FactsCard): toggle, presets (الاسم للتطريز, الحروف للحفر, ملاحظة), English and Arabic label, max length (default 20), a required checkbox. An off toggle with labels typed is kept as `{enabled:false,...}` so the labels survive; off with nothing typed saves `null`.

**Where it renders.**

- PDP, both paths: `PersonalisationField` above add-to-cart (one label, one input, one helper line). The helper line shows only the counter until intent: the "اكتب الاسم للتطريز الأول" hint appears after the empty field is blurred or after a blocked add (F6). When required and empty, every add button (main, sticky, Dahab main and pinned) stays enabled-looking; a tap scrolls to and focuses the field and reveals the hint, and adds nothing (`noteMissing`, separate from the one `addDisabled`). The label is the merchant's label in the active language, else "Personalisation" / "التخصيص". An option still unset works the same way (C-02, 2026-10-15): it is never an `addDisabled` reason and never relabels the button ("Add to Cart" / "إضافة للسلة" at every step); every add button's tap bumps `VariantSelector`'s `nudge`, which scrolls to and focuses the first unset option group, rings it and fills that group's `aria-live` line ("Choose Size" / "اختر المقاس"). `disabled` means the item cannot be bought (out of stock with no backorder). The input and its helper row span the buy column, as wide as the add button (AT-2, supersedes F14 under Ruling B1-70). The WhatsApp product button is gated only on the missing note (B0-20).
- Line display (`CartLineNote`, "✎ Sara"): the cart page and the six `CartTable`s, the Dahab `CartDrawer`, checkout `OrderSummary`, the success-page receipt, the account order detail.
- Variant line (every surface that prints one): each option value in its own `<bdi>`, joined " · " (`VariantText` in `@ebda/ui`, `variantTitleSegments` in `@ebda/shared`), so "وردي / M / 54 سم" never reorders to "وردي / 54 / M سم" (F8): the cart page, the six `CartTable`s, the Dahab `CartDrawer`, the receipt, the account order detail, the admin `ItemsCard`, the orders PWA and the scan-to-pick list, and the order-confirmation email.
- Admin: the order `ItemsCard` (highlighted row with a copy button), the scan-to-pick screen (`stock/scan`), the orders PWA (`apps/orders`). Invoice (`invoice.service.ts`) and the order-confirmation email carry `✎ <bdi>note</bdi>`, escaped. The WhatsApp order message adds a "✎ label: note" line. MCP `add_to_cart` accepts `note`; `view_cart` shows it.
- Quick-add on a card or wishlist "move to cart" for a required product sends the shopper to the PDP instead.

**Data.**

- `Product.personalisation` JSONB `{ enabled, label, labelAr, maxLength, required }`.
- `CartItem.note` TEXT; line identity is `(cart, product, variant, COALESCE(note,''))`, two unique indexes `cart_items_line_no_variant` and `cart_items_line_with_variant` that replace the old `cart_items_cart_id_product_id_*` pair.
- `OrderItem.personalisation` TEXT, plus the variant title snapshot in BOTH languages (B0-41): `variantName` = the variant's canonical `title` (as before B0, whatever the buyer's language), `variantNameAr` = its `titleAr` (`order_items.variant_name_ar`, nullable; null on older orders). The storefront (receipt, account order detail) and the confirmation email render `variantNameAr` in Arabic, falling back to `variantName` (`orderLineVariantTitle`); the admin `ItemsCard`, the orders PWA and the pick list render per the admin locale with the same fallback. Fiscal documents, the invoice and the CSV exports keep `variantName` exactly as before. Admin manual orders snapshot both too. Checkout still sends `locale`.

**Limits.** `maxLength` 1-200 (default 20); a hard cap of 200 characters whatever the merchant sets (`PERSONALISATION_NOTE_MAX`); a request note is at most 400 characters. Invisible and direction-changing characters (controls, zero-width, bidi marks and embeddings, BOM) are stripped before the length is measured; the length is checked before truncation. Errors: 400 `PERSONALISATION_REQUIRED` and `PERSONALISATION_TOO_LONG`, raised on add and re-checked at order create (a rule tightened after the add refuses the order and the checkout sends the shopper to the cart). The bulk guest-cart sync skips a rule-breaking line instead of failing (T5-1).

**Rulings.** B0-18, B0-19, B0-20, T5-1, T5-2, T5-3. Admin manual orders and bundle components have no note.

## 6. Sticky add-to-cart and cart-total bars

**What.** On a phone, a bar fixed above the tab bar: on the PDP it carries the product title, price and the add-to-cart button whenever the main button is off-screen in either direction (below the fold or scrolled past, B0-49), where "on screen" means above the tab bar (the observer's bottom edge is pulled up by `--bottom-tab-h` plus the safe-area inset, so a button hidden under the tab bar counts as off-screen); on the cart it carries the summary's Subtotal (label, value and money format, verbatim: shipping is "calculated at checkout" on the cart, so the cart total carries no zone fee, F1), the item count and a checkout button.

**Where the merchant edits it.** Nowhere: it is platform behaviour. No toggle (B0-4).

**Where it renders.** `StickyAddToCart` on the default PDP (`md:hidden`). Dahab keeps its existing pinned bar, setting the same body flag. Since C-04 (2026-10-15) every task bar (buy bar, Dahab pinned bar, cart total) REPLACES the BottomTabBar while it shows instead of stacking on it: `useStickyBarHeight` marks `<html data-task-bar>` (globals.css hides `[data-bottom-tab-bar]`), the bar sits at `bottom-0` with the safe-area inset in its padding, and its measured `--sticky-bar-h` (on `<html>`) feeds `scroll-padding-bottom` and the floating widget's lift (the toast anchors at the top instead, IA-17 + P2-13, Ruling B1-82). The PDP breadcrumb is hidden below `md`. Gates: `tests/unit/fixed-bottom-single-layer.test.ts`, `StickyAddToCart.test.tsx`, and `npm run test:fixed-bars` (real Chromium, 390 ar: one bottom layer, first selector above the bar, last control and promo field unobscured). `StickyCartTotal` on `CartClient` (it repeats the summary's Total row, after discounts); when checkout is blocked (below the minimum order, an unavailable line) it shows the existing `checkoutBlockedMessage` and the button is disabled. The sticky add button takes `addDisabled` and the label from the main button (one value, never recomputed), pinned by `tests/unit/pdp-sticky-parity.test.tsx`. The WhatsApp order button (`WaMeProductButton`, both PDP paths) shares the same `noteMissing` nudge: with a required note empty it is an `aria-disabled` button whose tap scrolls to and focuses the field, never an inert link.

**Body flags and lift.** `body[data-sticky-atc="1"]`, `body[data-sticky-cart="1"]` and `body[data-sticky-cart="blocked"]` reserve page space (8rem + 4.25rem, plus 1.5rem when blocked) and lift the floating widget (F2; see `docs/architecture/store-theme-flags.md`). The toast region (`data-toast-region`) no longer lifts: it anchors at the top at every width, clear of the inline add button, the wishlist button beside it and every bar (IA-17, taste re-audit P2-13, Ruling B1-82). The bar lifts by `--bottom-tab-h` (69 px) plus the safe-area inset (B0-6), and the widget lift is `--bottom-tab-h` + the bar's measured height (`--sticky-bar-h`, published by `useStickyBarHeight`; default 61 px, 85 px blocked) + 10 px, so the taller Dahab bar and the cart's blocked line are cleared too. It slides in over 300 ms (ease-out-quint, Dahab's pinned bar too, on a solid background, F10); reduced motion shows it at once. The cookie banner (z-100) may cover a bar until it is answered (B0-42).

**Data.** None.

**Limits.** Phones only. The PDP bar shows from first paint when the main button starts below the fold or under the tab bar, and never when it is reachable (B0-49; B0-21: it attaches once).

**Rulings.** B0-6, B0-21, B0-42.

## 7. Video upload and the `video` setting kind

**What.** The page builder can hold a video setting, uploaded by the merchant, for any block that declares one. Hero video (section 8) is the first user.

**Where the merchant edits it.** Admin → Builder (`/stores/[id]/builder`) → the block's settings panel, which renders `VideoField` for any setting of kind `video` (`SettingsPanel` `case 'video'`). Upload only, no media-library picker. It shows the size of the file uploaded in this session and the error for an oversized or wrong file.

**Where it renders.** Wherever a block reads that setting; today `HeroBanner` and `dahab/Hero` (section 8).

**Data and route.** `POST /uploads/video?folder=hero|builder` (admin, `products:write`, the upload and daily-upload limiters, audit-logged). MP4 or WebM, verified by content (`lib/video-sniff.ts`: `ftyp` with an allowed major brand for MP4, an EBML header with a `webm` DocType for WebM) and the declared mime must match; the stored extension comes from the sniffed type. Stored on R2 with `Cache-Control: public, max-age=31536000, immutable`. The URL lives inside `layoutSettings` or `StorePageRevision.document` JSON, both scanned by the R2 orphan sweep, so no registry entry was needed. The Workers multer stub (`cf/stubs/multer-formdata.ts`) now caps the body by `Content-Length` and a byte-counting stream before buffering, for every upload route; when the counter trips, the stub raises `MulterError('LIMIT_FILE_SIZE')` (so a 413) even if `formData()` reports the abort as its own TypeError (workerd), and an `.array(name, max)` with no `limits.files` is capped at `max` files, not one. Web and admin CSP gain `media-src 'self' https://*.r2.dev https://media.ebda.app blob:` (B0-22).

**Limits.** 6 MB (B0-2), folders `hero` and `builder` only, an HTTP 413 above the cap, 400 for the wrong type. Every other multer route (image, images, font, receipts, imports) is mapped centrally in `errorHandler`: a size error is 413 `FILE_TOO_LARGE`, any other `MulterError` 400, and a `fileFilter` rejection its own 400 `INVALID_FILE_TYPE` (they were 500s before the verification wave). The `video` kind is in `packages/shared/src/builder/settings-schema.ts` (`s.video`).

**Rulings.** B0-2, B0-22, B0-23, B0-24, B0-25.

## 8. Hero video

**What.** A hero slide can play a muted, looping clip over its poster image. The poster is always the base layer, so the first paint and LCP are the poster; the clip fades in after hydration.

**Where the merchant edits it.** Admin → Builder → a hero block → each slide has **video** and **videoMobile** next to the two image settings (from the registry, `HERO_SLIDE_BLOCK`). The legacy slide editor needs no change: it spreads unknown slide fields, so they survive an edit (pinned by `admin-page-builder-save.test.ts`).

**Where it renders.** `templates/shared/HeroBanner.tsx` (single hero and, through `HeroSlider`, every slide) and `templates/dahab/Hero.tsx`. `HeroVideo.tsx` mounts the `<video>` only when motion is welcome: not reduced motion, not Save-Data, no load error. It reacts live to those, picks `videoMobile ?? video` by viewport, pauses on a carousel slide that is not showing (`active`), and uses `object-contain` in a framed hero. A video that 404s or a refused autoplay removes the element and leaves the poster, with the same box size (no layout shift).

**Data.** `video` and `videoMobile` on a hero slide: https or relative URLs only (`heroSlideSchema`, and `validate.ts` `VIDEO_KEY_RE` for the publish scan). No migration; the slide JSON lives in layout settings and page revisions.

**Limits.** One clip per slide (plus a mobile one). The image stays the required poster, and `posterMobile` was dropped: the slide's `imageMobile` serves mobile (B0-27). Not verified on real R2 range requests or Safari low-power mode.

**Rulings.** B0-2, B0-27.

## 9. Size charts

**What.** A store-owned size table (columns x rows of short text) that a merchant links to a product or a whole category. The PDP shows a "دليل المقاسات / Size guide" link that opens it in a dialog; `/size-guide` lists every chart.

**Where the merchant edits it.**

- Admin → Products group → **Size charts** (`/stores/[id]/size-charts`, a catalog hub tab): list with name, shape, unit and used-by counts, and the grid editor (`SizeChartEditor`) with three templates ("عباية (مقاس x طول)", "ملابس (S-XXL)", "مقاس الخاتم"), AR and EN headers, a cm/in toggle and an AR/EN preview.
- Link it from a product: Edit → **FulfilmentCard** (default "من القسم", meaning inherit), or from a category in the category form (default "بدون"). Both use the shared `SizeChartSelect`.

**Where it renders.** `SizeChartDialog` (a native `<dialog>`, page scroll locked while open) on both PDPs: beside the Size axis when the product has one (`VariantSelector`'s `sizeGuide` slot; `isSizeOption` also matches "الحجم" and "مقاسات"), else on its own line. `app/size-guide/page.tsx` (404 when the store has no chart). Public API: `GET /public/size-charts`, and the PDP payload's `sizeChart`.

**Resolution (T9-2).** The product's own chart; else the first live category, ordered by `categories.position`, that has one; else none. A deleted chart nulls the references (FK `ON DELETE SET NULL`) and the link disappears with a 200, never a 500.

**Data.** New table `size_charts` (`store_id`, `name`, `name_ar`, `unit` cm|in with a CHECK, `columns` JSON, `rows` JSON, `note`, `note_ar`), strict RLS (`ENABLE` + `FORCE` with `ebda_tenant_isolation`, checked on a real `ebda_app` login and by `rls-ebda-app.test.ts`), plus `products.size_chart_id` and `categories.size_chart_id`. Admin routes under `/stores/:storeId/size-charts` (`products:write`, T9-1; cross-store links are a 404 `SIZE_CHART_NOT_FOUND`). The tenant-guard snapshot was regenerated (`npm run gen:tenant-guard-schema -w packages/database`).

**Limits.** 2-10 columns, 1-30 rows, a cell is at most 24 characters, name 60, note 300, one cell per column per row. A malformed stored row resolves to no chart (`toPublicSizeChart`).

**Rulings.** T9-1, T9-2, T9-3, B0-28, B0-29.

## 10. Receipt-printer success page

**What.** The order-success page shows the order as a thermal receipt that prints out of a small printer, for every skin. Lines (with the variant in the shopper's language, each option value in its own `<bdi>`, and the personalisation note), totals, payment method, date ("15 Oct 2026" / "15 أكتوبر 2026": day, short month, year, in the store's time zone and numerals, never the month-first "10/15/2026", F13) and a decorative barcode with the real order number, printed once under it (the duplicate "رقم الطلب" row is gone, F12).

**Where the merchant edits it.** Nowhere: it reads the order. It follows each skin's tokens (screen, bezel and slit mixed from foreground and background; the paper is always white with dark ink).

**Where it renders.** `components/commerce/ReceiptPrinter.tsx` inside `app/checkout/success/SuccessClient.tsx`. No skin overrides the success page, so every template gets it. When the receipt renders it replaces the hero check and the COD banner (B0-32); the old hero stays if the order fails to load. The Instapay and Fawry cards and the WaMe COD confirm button stay.

**Payment honesty.** The status line follows the real payment state: verifying, paid, COD ("الدفع عند الاستلام"), awaiting, pending, failed or unknown. The word "paid" ("المدفوع") appears only when the order is paid; a COD or awaiting order says "Total", never "Total paid" (`ReceiptPrinter.test.tsx`, "cod never says paid").

**Motion.** The paper feeds out over 1600 ms (ease-out-quint, transform only, 250 ms after the order arrives), then the status fades in and the check draws. It runs once per order (`sessionStorage['receipt-printed:'+id]`, wrapped in try/catch), a reload does not re-feed, and a 2250 ms backstop settles the status if `animationend` never fires. Reduced motion shows the final state at once. Arabic never uses the mono font; English labels use mono small caps (B0-34).

**Data.** `GET /public/orders/:id` already returned everything; the web `Order` type gained optional `subtotal`, `shipping`, `discount`, `codFee`, `tax`, `taxIncludedInPrice`, `payments`. The barcode is decorative and not scannable (B0-3).

**Limits.** A residual 68 px load jump on a three-line order (B0-35).

**Rulings.** B0-3, B0-32, B0-33, B0-34, B0-35, B0-41.

## 11. Store-wide `settings.deliveryDays` fallback

**What.** A store that prices shipping per area has no day estimate, so the chip (section 4) would never show. A store-wide `{min, max}` in business days fills that gap. It is used only when no active zone carries numbers.

**Where the merchant edits it.** Admin → **Delivery** (`/stores/[id]/delivery`): two number inputs, labelled "مدة التوصيل (أيام عمل)" / "Delivery time (business days)", and a Clear button.

**Where it renders.** Only through `DeliveryChip` on both PDPs.

**Data.** `Store.settings.deliveryDays` (`{ min, max }`, integers 0-30, `min <= max`). No migration. The settings merge is shallow, so Clear sends an explicit `null`. Whitelisted for the storefront in `lib/public-store-settings.ts`. Validated on every writer: `POST /stores` and `PUT /stores/:id` run the same `addSettingsIssues` (this `deliveryDays` check, plus the `contact.addressUrl` and floating-widget link scheme checks, which used to run on the update only and left store creation as the bypass; `tests/unit/store-create-settings-links.test.ts`); the two `store.service` splices cannot write the key.

**Limits.** 0-30 business days. A malformed stored value hides the chip.

**Rulings.** B0-5, B0-16.

## 12. Per-store days with no delivery (`settings.deliveryOffDays`)

**What.** The delivery estimate used to skip Friday only. The courier calendar is now a store setting. It applies to zone estimates AND the `deliveryDays` fallback, since it is the store's calendar and not the fallback's.

**Where the merchant edits it.** Admin → **Delivery** → "أيام بدون توصيل" / "Days with no delivery": seven toggle chips, Saturday first (Egyptian week), Friday selected by default. Selecting all seven disables Save and says why.

**Data.** `Store.settings.deliveryOffDays?: number[] | null`, weekday numbers as `Date#getUTCDay` (0=Sun ... 6=Sat). Unset/null = `[5]` (Friday, the previous behaviour: no existing store changes). `[]` = delivers every day. Unique integers 0-6, at most 6 entries (`deliveryOffDaysSchema` in `delivery-window.ts`, reused by the API). No migration. Shallow merge, so clearing sends an explicit `null`. Validated by `addSettingsIssues` on `POST /stores` and `PUT /stores/:id`; whitelisted in `lib/public-store-settings.ts`; passed to `deliveryWindow({ offDays })` by `DeliveryChip` (both PDPs render that one component). A malformed stored value falls back to Friday.

**Rulings.** B0-48.

## 13. Instalment estimate on the PDP (`settings.instalments`, Phase B2)

**What.** A merchant who offers instalments can show "تقسيط من 1,290 ج.م في الشهر على 12 شهرًا · تقريبي" (English: "From EGP 1,290 / month for 12 months · estimate") in the PDP price row. It is ARITHMETIC over the merchant's own numbers: `ceil(price x (1 + markupPct/100) / months)` in integer minor units (the markup in basis points, so 2.5 % is exact). It is not a payment method, integrates no provider, ships no logo or brand, and never changes a checkout total (Ruling B2-9).

**Honesty rules.** Renders only when `enabled`, the displayed price (the selected variant's sale price, never the struck compare-at) is at least `minPrice` (default 0) and the product can be bought now (`canBuyNow`). The word "تقريبي" / "estimate" is always there. A provider appears only as a typed NAME (`providerAr`/`providerEn`, 40 chars), never an image. With the setting absent the PDP is unchanged. Never on any card path, in the cart, or in checkout (`tests/unit/instalment-line-render.test.tsx` pins exactly one importer).

**Where the merchant edits it.** Admin → **Payment settings** → "سطر التقسيط في صفحة المنتج": enable, months (3 to 60), added cost %, optional provider names, optional minimum price, Save and Remove. The card's first line: "فعّلها بس لو بتقدّم التقسيط فعلًا" / "Turn it on only if you really offer instalments."

**Data.** `Store.settings.instalments = { enabled, months, markupPct, providerAr?, providerEn?, minPrice? }`, strict (an unknown key is refused), no migration. Shallow settings merge, so Remove sends an explicit `null`. `instalmentsSchema` (`@ebda/shared`) is validated on `POST /stores` and `PUT /stores/:id` by `addSettingsIssues`; whitelisted for the storefront in `lib/public-store-settings.ts`.

**Limits.** Months 3 to 60, markup 0 to 100 %. A malformed stored value shows nothing.

**Rulings.** B2-9.

## 14. Tag chips, routine steps, PDP rating and bundle saving (Phase B3, Jasmine)

Four platform pieces, available to every skin (never one tenant). Ingredients, actives, PAO/expiry, skin type and how-to-use are NOT here: they are B0 product facts (section 3) by convention (Ruling B3-4).

**Tag chips** (`category-grid` with `source: 'tags'`). **What.** The category row can list the store's TAGS instead of its categories: "حسب نوع بشرتك" / "اختار مشكلتك". Each chip is a >= 44px text link to `/products?tag=<name>`; the PLP shows the result count and one control to clear the filter. **Honesty rules.** Only tags with at least one ACTIVE, PUBLIC, non-deleted product ever appear (`GET /public/tags`), most used first, at most 12, so no chip is a dead end; zero chips renders no section. **Where the merchant edits it.** Page builder, Categories section, "Shows: Categories / Tags" (generated from the registry, `source` setting). **Data.** The existing `Tag` / `ProductTag` tables plus one nullable column, `Tag.nameAr` (migration `20261030000200_tag_name_ar`). `name` stays the canonical English label and the `?tag=` filter key; `nameAr` is the Arabic label. The storefront picks the label by page language (`apps/web/src/lib/tag-label.ts`) and marks a fallback with `lang` (WCAG 3.1.2); the same helper renders the chip, the PLP title and the clear button. The merchant edits both on Admin > Store > Tags (`PUT /stores/:id/tags/:tagId`, with an AI-translate button; settings-registry entry). `GET /public/tags` returns `nameAr`. Ruling B3-13. `GET /public/products?tag=<name>` matches `Tag.name` exactly inside the same store (the tag row is storeId-scoped, so another store's tag of the same name matches nothing); it is refused with `sort=on_sale`. CACHE CLASS: BOUNDED-stale, 120 s Redis under `public:products:<storeId>:tags` (busted by `invalidateStoreProductCaches`) plus the 60 s edge copy. **Rulings.** B3-5.

**Routine steps** (`steps` section, document-only). **What.** An ordered `<ol>` of 2-5 `step` blocks (name, one line, optional product by reference, optional link). Numbers show because ORDER matters. **Honesty rules.** Fewer than two steps is not a routine and renders nothing (a dashed hint in the editor); an unknown or foreign product id shows the step without a product (C11). "Add all" exists only when EVERY step has a product that is buyable now with no options to pick (the `canBuyNow` rule; a variant product links to its page instead). It adds the real products through the cart's own path, or the REAL bundle when one holds exactly these products (`bundle-savings` `exact`), and then shows the bundle's live saving: a saving is never a number written in the page. A step ticks (`data-done`) when its product is already in the cart. **Where the merchant edits it.** Page builder, "Routine steps" section and its Step blocks (product picker, max 1 per step). **Data.** Document-only (`legacyKey: null`); product refs are collected by `collectRefs` like shop-the-look pieces.

**Routine steps are a product row path (B3-16).** Prices follow the store's card-price switch, a sale step shows its struck original, a sold-out step shows the store's sold-out label, and the "add all" total is hidden with the prices. The PDP bundle line reads "in a bundle" (platform-wide wording).

**PDP rating line.** One inline "★ 4.7 · 212 تقييم" under the title, linking to the reviews block (`#reviews`, the `ReviewSection` root; client-only, so SSR markup is unchanged). It reads `ratingStats` from the cached public product payload (published, verified-purchase reviews only) and renders NOTHING without a rating, and nothing when the reviews block itself is off (plan feature or the merchant switch; one `reviewsOn` condition, so the link never points at a missing anchor). The Dahab product page carries it too (B3-16). There is no rating on any card (Ruling B3-6, B0-4). CACHE CLASS: BOUNDED-stale (120 s Redis + 60 s edge); review approve / reject / delete / status edits purge the product caches (`refreshRatingCaches`), so the residual is only a failed purge.

**PDP bundle-saving line.** One line, "وفّر 15% لما تشتريه في باقة", linking to the bundle page, only when an active, purchasable bundle containing this product gives a saving > 0 on a store that has the `bundles` feature (read off `store.enabledFeatures`, so a store without it makes no request). CACHE CLASS: NEVER-stale for price. `GET /stores/public/:storeId/bundle-savings?productIds=<uuid>[,..]` (1-5 ids) computes it from `resolveBundle` (the cart's own bundle price) on every request, answers `no-store`, and has no cache layer to forget. **Rulings.** B3-6.

With neither line applicable the PDP markup is unchanged and the 390 fold keeps gallery, title, price, first selector and the sticky add bar.

## 15. Card stepper (Phase B4, Lamma; Ruling B4-4)

On a look that sets `chrome.cardStepper: 'inline'` (the three Lamma looks), the card's one add control becomes `- qty +` once the product is in the cart. It is a state of the CTA, not a second control, and it lives in the shared pieces every card path already reaches: `AdaptiveAddButton` (the shared card and the shared carousel) and `ProductCardCta` (the five template cards), so there is no new card data path. `CardStepperProvider` (mounted by `ShopChrome`) hands the cart lines to the cards only on such a look; elsewhere it provides null and every card renders byte-identically.

- **When.** One plain line of a non-variant product (`stepperLine`). A variant product keeps its "view" route to the page, a product with two lines (the same dish with two notes) keeps the single add control, an unavailable line never gets a stepper.
- **Targets and signs.** Both buttons are 44px, drawn as icons (`MinusIcon`/`PlusIcon`, the stepper-minus-glyph gate), the quantity is a polite live region.
- **Limits.** The server owns the cap: a refused `+` restores the quantity, the live region says "وصلت للحد الأقصى للكمية" and the `+` stays off until the quantity changes. `-` at 1 removes the line and raises the same Undo toast as the cart page (`cartRemovalToast`: same variant, same note, same quantity).

## 16. Browse cart bar and minimum-order progress (Phase B4, Lamma; Ruling B4-6)

`chrome.cartBar: 'total'` (look data) enables a phone bar with the item count, the total (the shared price formatter) and the cart link, on home, the product list, category pages and search only (`browseBarShownOn`), while the cart has items. It is a task bar in the C-04 sense: `useStickyBarHeight` marks `<html data-task-bar>`, so it REPLACES the bottom tab bar and never stacks with the PDP buy bar or the cart total bar (those routes are excluded). It reserves body space through `body[data-sticky-cart]`, which also lifts the floating widget; the value is `blocked` (taller) while the minimum-order progress shows.

`MinOrderProgress` renders, only under a set `minimumOrderFils`, one sentence ("ضيف ٨٠ ج.م وتوصل للحد الأدنى للطلب") and a determinate `role=progressbar` (value, max, text; never colour alone). The bar carries it; the cart page shows it in place of the one-line notice on such a look. It is advice only: `checkMinimumOrder`, the blocked checkout button and the API's `MINIMUM_ORDER_NOT_MET` are unchanged. Absent minimum or a met minimum renders nothing.

## 17. "Order again" row and reorder-this-order (Phase B4, Lamma; Ruling B4-8)

`productSource: 'reorder'` is a source of the `product-carousel` (an extra carousel) and the `featured-collection` section: the signed-in customer's own last products.

- **Endpoint.** `GET /public/customers/me/reorder` (customer token): the DISTINCT product ids of the customer's last three PAID or DELIVERED orders (`paymentStatus: paid` or `status: delivered`; cancelled and refunded never count), newest order first (inside one order the biggest line, then the name, so the answer is stable), at most 12, only products that are still `active` and not deleted. Every query carries `storeId` and `customerId` (tenant guard). Anonymous is 401, an admin token is 403.
- **Staleness classes.** The id list is per customer and is NEVER cached (`Cache-Control: private, no-store`, `Vary: Cookie, Authorization`). The row then resolves current name, price and availability through the same tagged public product read every listing uses (`/public/products?ids=`: BOUNDED-stale, invalidated by `invalidateStoreProductCaches` on every product write) and keeps only what `canBuyNow`, in the customer's order. The add itself re-checks stock, variant and price server-side, so a stale row can mislead a tap but never a charge.
- **Renders nothing** for an anonymous shopper, a first-time customer, a refused list or a failed request: no wrapper, no placeholder, no empty padded band (`ReorderRow` owns its `<section>`). It mounts after hydration, so a look places it below the first screen (CLS is measured in the matrix).
- **Reorder this order.** An order's page (paid or delivered, never cancelled or refunded) has one "إعادة الطلب" button. It re-adds every line through `api.addToCart` with the SAME product, variant and note and the same quantity (bundle components are skipped, equal lines add up), refetches the cart once, then says in one sentence how many could not go back ("تعذّرت الإضافة: قطعتين مش متاحين دلوقتي"); with at least one line added the shopper lands on the cart. It never edits the old order.
- **Demo limit (Ruling B4-9).** A demo store refuses customer registration, so the row can never render on `storedemo-lamma`; it is exercised on the non-demo `lamma-reorder` scenario store.

## 18. Delivery date chips at checkout (Phase B4, Lamma; Ruling B4-7)

`settings.checkoutDelivery.daysAhead` (1-14) turns the today / tomorrow windows picker into date chips plus the windows bookable on the chosen date. The rule, the order-endpoint validation, the 422 `DELIVERY_SLOT_UNAVAILABLE` and the server-written notes line are specified in `docs/architecture/store-checkout-settings.md` (`daysAhead`). Platform behaviour in short:

- **Truth.** A chip is offered only if the server would accept it: earliest date = store estimate + the cart's longest `leadTimeDays` in business days, the store's off days skipped, store timezone (DST-safe: calendar days, never 24 h), today's windows obey `orderBy`. A stale tab, a clock that crossed a cut-off or midnight, or a hand-edited date is refused with a sentence next to the chips and the picks are cleared.
- **Chips.** `role=radiogroup`, roving tabindex, arrow keys move AND select (RTL-aware), 44 px targets, the selected chip is filled and carries a check (never colour alone). Relative words for the first two ("النهاردة", "بكرة"), then the date with Western digits. No date on offer says so in a sentence and never blocks checkout.
- **A store without `daysAhead` is unchanged**, pinned by a markup snapshot of `DeliverySection`.
- **Data flow.** The pick travels cart → checkout → order → receipt → admin notes as one line, proven end to end in `tests/integration/order-delivery-date.test.ts` (Review Focus 3), not at component level.

## Gold-rate pricing (Phase B5)

A product (or a variant that has its own weight) can be priced from today's gold rate. The merchant sets karat, weight (grams, two decimals, stored as milligrams), a making charge (per gram or fixed) and a margin; the store has one rate per karat (typed by hand or fetched automatically a few times a day). `price` stays the one price every reader uses and only the repricer writes it for a gold row, so the cart, order, feed, search and JSON-LD need no gold logic of their own.

- **Admin:** Catalog, Gold rates (rate editor with a confirm dialog on a big jump, pending automatic rate, settings, audited history); the product edit page has the Gold pricing card (live preview with the server's own formula, price field not typeable, switch refused without a fresh rate); bulk switch in mass edit; CSV columns `pricing_mode`, `gold_karat`, `gold_weight_g`.
- **Storefront:** under the price, one line: karat, weight, today's rate per gram, when it was recorded; the gold / making split only if the merchant turned it on. Past the store's limit the piece says it cannot be ordered yet and its buy buttons are disabled. A moved price shows "السعر اتحدّث" with a "متابعة" button on the cart and at checkout.
- **Rules a theme must keep:** never print the margin or the source of a rate; do not compute a price in the browser; the line is plain muted text (12px+), no motion.
- **Full map (model, formula, cache layers, failure codes, runbook):** `docs/architecture/gold-rate-pricing.md`.
