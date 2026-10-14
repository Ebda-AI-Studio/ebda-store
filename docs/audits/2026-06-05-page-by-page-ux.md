# Storefront Page-by-Page UX Audit

**Date:** 2026-06-05  
**Scope:** apps/web/src/app — all storefront pages + sub-states  
**Auditor:** Senior UX Auditor (read-only, no edits)  
**Standard container:** `mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8`

---

## Priority Legend

- **P0** — Conversion-blocking or trust-breaking. Fix before any merchant hands off.
- **P1** — Significant friction; likely costs sales or causes confusion.
- **P2** — Polish / consistency gap; noticeable on careful inspection.

---

## 1. Homepage (`HomePageContent.tsx`)

### 1.1 Responsive Behavior

- **P2** — Categories section uses `md:hidden` / `hidden md:block` dual-tree for mobile/desktop layout divergence (lines 454–459). This is functionally correct but creates two full DOM trees. On very low-end mobile at 390px, if `layout.categories.mobileColumns` is left at the desktop default (e.g. 4–5 columns), the fallback `renderGrid` will still render 4 columns of cramped ~80px cards before the template `CategoryGrid` can apply its own mobile-responsive logic. No explicit min-width guard on the mobile grid path.
- **P2** — Hero section: the `legacyHeroHasContent` guard (line 253) is correct, but when a store has _no_ hero content and no slides, the hero `<div data-section="hero">` still renders as an empty wrapper with a `sectionBgStyle`. On some background-preset configurations this produces a thin colored band at the top of the page below the header — visually confusing. Needs either `display:none` or a `!legacyHeroHasContent && !sliderEligible && !bannerEligible` early-return.

### 1.2 Information Hierarchy & Scannability

- **P1** — The homepage `featured products` fallback (lines 831–847) is the _only_ product display when both `newArrivals.enabled` and `bestSellers.enabled` are false, yet it has no heading customization (hardcoded `"Featured Products"` / `"منتجات مميزة"`). Merchants who disable both carousels land on an unlabeled grid with no merchant-controlled section title.
- **P2** — `HomeBlogCarousel` (line 659) and `BrandStoryBlock` (line 642) render _before_ the testimonials section but _after_ best sellers. Neither component is audited here (outside scope), but if blog posts are empty, the carousel may render an empty band with only the section heading — no empty-state guard in the homepage render path.

### 1.3 States

- **P1** — No global loading state for the homepage. If the server-side product fetch is slow or fails silently, the page renders with zero products in all carousels. There is no skeleton, no "failed to load" message, and no retry CTA visible to the shopper. The carousels simply disappear (condition: `templateNewArrivals.length > 0` on line 479). Shopper sees blank sections without knowing why.
- **P2** — Testimonials section has no loading skeleton; it either renders or doesn't. If the `testimonials` array arrives empty due to a failed SSR fetch (not a legitimate "zero reviews" state), the section vanishes silently.

### 1.4 Consistency

- Matches the standard container on the `mx-auto max-w-7xl px-4 sm:px-6 lg:px-8` blocks inside each section. Section paddings are `py-14 sm:py-16 lg:py-20` — consistent internally.
- **P2** — The fallback `featured products` section uses `py-14 sm:py-16 lg:py-24` (note `lg:py-24`) vs. `lg:py-20` everywhere else on the homepage. Minor vertical rhythm inconsistency.

### 1.5 Conversion/Ecommerce UX

- **P1** — `handleAddToCart` on the homepage (line 205) adds by `productId` only. It does NOT check `product.inventory`, `product.status`, or whether the product has variants requiring selection. A shopper can tap "Add to cart" on a variant product from the homepage carousel and the item is added without a variant — the order would contain an incomplete SKU. The PDP guards this correctly (line 304) but the homepage carousel does not.
- **P2** — `extraCarousels` products (lines 748–816) fall back to `templateNewArrivals` when the category slug matches no products (line 763). The shopper sees "correct-looking" carousel content that is actually unrelated products — misleading merchandising.

### 1.6 A11y

- **P2** — Section headings (`<section data-section="...">`) have no accessible `aria-labelledby`. The `SectionHeading` subcomponent likely handles this, but the outer `<section>` element carries no `aria-label` or `aria-labelledby` at this level of the tree.
- **P2** — `handleAddToCart` fires without any confirmation toast on the homepage (the CartContext may fire one centrally, but this should be verified — the comment on line 338 of ProductDetailClient confirms central toast exists, but the homepage handler at line 205 is simpler and doesn't call `toastSuccess`).

---

## 2. Product Listing Page (PLP) — `ProductsClient.tsx` + `ProductsFilterSidebar.tsx` + `ProductsPagination.tsx`

### 2.1 Responsive Behavior

- **P1** — The view mode toggle (grid/list) is `hidden ... sm:flex` — visible only at `sm` and above (line 460). On mobile the shopper has no way to switch to list view. The list view component exists and works (`ProductListItem`), but it is inaccessible on the primary mobile breakpoint. Either expose it in the mobile filter sheet, or make it always visible.
- **P1** — The view mode toggle lives inside the **sidebar column** (`flex shrink-0 flex-col gap-4 lg:w-72`). On mobile the sidebar column collapses behind the bottom-sheet, so the toggle also disappears. On tablet (`sm` to `lg`) the sidebar column is visible inline but narrow — the toggle appears but the sidebar width `lg:w-72` is only applied at `lg:`, meaning at `sm`/`md` the sidebar stretches to full width and the toggle sits oddly above a wide filter panel.
- **P2** — Price range uses two separate `<input type="range">` elements in a `grid grid-cols-2` (lines 245–274). On mobile at 390px each slider gets ~180px — workable, but they share the same track visual drawn with `insetInlineStart` / `insetInlineEnd`. If `priceMin` and `priceMax` are equal, the track bar disappears visually (zero-width fill). No guard for this edge case.
- **P2** — The `perPage` selector and `resultCount` display are inside the filter sidebar, not above the grid. On mobile these are hidden behind the "Filters" bottom-sheet button. Shoppers have no way to know how many results are showing without opening the filter sheet.

### 2.2 Information Hierarchy & Scannability

- **P1** — The H1 subtitle is hardcoded as `'Browse our collection of premium products'` (line 414). This generic copy appears on every tenant's PLP. It undercuts merchant branding and can feel inaccurate (e.g. a grocery store). Should pull from a store-configurable field or be suppressed when unset.
- **P2** — Sort and per-page controls are buried inside the filter sidebar. Most ecommerce PLPs expose sort above the grid (separate from filters). A shopper who doesn't think to open "Filters" never discovers the sort or per-page options.

### 2.3 States

- **P0** — Error state has a Retry button (line 548), but when `priceMax < 100` AND the error is a connection error, the retry call passes the current `page` not page 1. If the user was on page 5 and a network drop occurred, retry re-fetches page 5 — which may still 404 depending on the filter state. Not blocking by itself but combined with the filter state complexity it can leave the user stuck.
- **P1** — Loading state renders a `grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3` skeleton (line 560–565) — 3 columns max. The real grid uses up to `2xl:grid-cols-6`. The skeleton column count mismatch causes visible layout jump when the real grid loads (skeleton is wider per card, then snaps to narrow 6-column cards).
- **P1** — `isLoading` is `true` on first mount when `initialProducts.length === 0` (line 137). The page immediately shows 6 skeletons. If SSR provides products (`initialProducts.length > 0`), loading is `false` but then the `useEffect` on line 283 fires and sets `isLoading=true` again to re-fetch. This causes a visible flicker: products appear (SSR), then disappear behind skeletons, then reappear. The `prevFiltersRef` logic tries to prevent this but `filtersChanged` computes to `true` on first run because refs are set AFTER fetch.
- **P2** — No results state (line 634) shows a "Clear Filters" button that only clears `search` and `categoryFilter` but NOT `sortBy`, `priceMin`, or `priceMax` (lines 665–668). A shopper with a price range filter set will still see 0 results after clicking "Clear Filters." The full `handleClearAll` function (line 363) does clear everything — it should be called here instead.

### 2.4 Consistency

- Container matches the standard (`mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8`). Consistent.
- **P2** — Breadcrumb chevron (line 395) is `h-4 w-4`, while the PDP breadcrumb uses `h-3.5 w-3.5` with a left-arrow (`←`) pattern. The two pages use different breadcrumb arrow styles — one is a right-pointing SVG chevron, the other is a `←` arrow. Inconsistent separator pattern across pages.

### 2.5 Conversion/Ecommerce UX

- **P1** — `PecannbeeProductCard` on the PLP passes `urlPrefix={storeUrl('')}` but does NOT pass `onRemoveFromWishlist` — only available on the wishlist page. The wishlist heart button on PLP cards operates via the PDP wishlist handler which requires an API call. Since the PLP card is `PecannbeeProductCard` (not `T.ProductGrid`), the wishlist heart state is never initialized from the API on PLP — a logged-in shopper's existing wishlist is not reflected on the PLP card hearts.
- **P2** — Price range filter ceiling is hardcoded at `priceCeil={100}` (line 452) regardless of actual catalog prices. A store selling items at 200 KWD will show `priceMax` slider maxing at 100. The comment on line 130 acknowledges "data-driven ceil" but the implementation never updates it from the fetched products.

### 2.6 A11y

- **P1** — Pagination buttons (ProductsPagination.tsx line 27) render as plain `<button>` with numeric text only. No `aria-label="Page N"` on numbered buttons and no `aria-current="page"` on the active page. Screen readers cannot identify the current page in a numbered pagination row.
- **P2** — Category filter buttons in the sidebar use `aria-pressed` (line 319) — correct. But the active category shows `bg-primary text-white` with no additional visual indicator beyond color (no checkmark, no underline). Color-only active state fails WCAG 1.4.1 for users with color blindness.
- **P2** — The mobile "Filters" bottom-sheet backdrop click closes it (line 429 `onClick={() => setIsOpen(false)}`), but there is no `role="button"` and no `aria-label` on the backdrop div, so keyboard users cannot close it without the X button.

---

## 3. Product Detail Page (PDP) — `ProductDetailClient.tsx`

### 3.1 Responsive Behavior

- **P1** — The thumbnail grid uses `grid grid-cols-4 gap-4` (line 487) regardless of how many images exist. With 2 images, you get 2 wide thumbnails separated by blank space. With 5+ images you get a 5th thumbnail pushed out of the 4-col grid and orphaned on a second row, breaking the visual alignment. No `grid-cols-{count}` or `max-w` cap on thumbnail strip.
- **P2** — The main product image `<div className="{pdpAspectClass} overflow-hidden rounded-2xl...">` has `width={800} height={800}` but `sizes="(max-width: 1024px) 100vw, 50vw"` (line 463). At desktop (`≥1280px`) the product image occupies 50vw = ~640px. The 800px image is slightly oversized for the slot but fine. At mobile the `100vw` with the padding removal gives ~358px — the `aspect-square` (or configured ratio) controls height. This is acceptable but the `priority` flag (line 465) applies to the main image regardless of SSR hydration — correct for LCP.
- **P2** — Related products grid uses `grid-cols-2 sm:grid-cols-3` (line 711) but maxes at 3 columns even on large desktop screens. Other product grids go to 5–6 columns at XL/2XL. Related products looks oversized / low-density on large monitors.

### 3.2 Information Hierarchy & Scannability

- **P1** — When the product has variants but none is selected (`variantRequired = true`), the price display falls into "range" mode showing `min–max`. The CTA button shows "Select Options." However, there is no callout or highlighted prompt near the `VariantSelector` itself telling the user WHICH option they must pick. A shopper may click "Add to Cart," see the button is grayed/relabeled, and not immediately understand they missed a step above.
- **P2** — The discount badge (`% OFF`) is calculated against `displayCompare` (line 524). For variant products, `displayCompare` is `null` until a variant is selected (line 551 guards on `pricing.mode === 'single'`). This is correct behavior but visually the badge appears/disappears as the user selects variants — jarring if the discount badge was visible on the card and disappears on the PDP until a variant is chosen.
- **P2** — `product.sku` renders as plain `"SKU: {sku}"` text (line 657) below the action buttons. There is no label styling — it blends into the muted text region. For B2B or repeat shoppers who reference SKUs, this should be more scannable (e.g. `bg-muted rounded px-2`).

### 3.3 States

- **P1** — Error state (lines 350–369) shows a raw API error message (`setError(response.error?.message || 'Product not found')`). API messages may contain internal terminology. Only the fallback `'Product not found'` is safe for end users. The catch block uses a safe hardcoded string (line 269) but the response path at line 265 exposes raw API messages.
- **P1** — When `initialProduct` is provided via SSR but the product has been unpublished between SSR and client render, the client never re-fetches (the `if (initialProduct && product)` guard on line 206 skips re-fetch). A stale "published" product can be shown to a customer when it's already draft/deleted.
- **P2** — `isAdding` state (line 308–310) uses a hardcoded `setTimeout(resolve, 300)` to simulate add latency. This artificial 300ms delay means the button spinner shows for 300ms even if the cart add is instant (local state). On slow connections the button will appear "done" before the actual cart context has updated. Confusing ordering.
- **P2** — `selectedImage` resets to `0` when variant changes (lines 157–161) but this runs even if `selectedVariant.imageUrl` is null/undefined (line 159: `if (selectedVariant?.imageUrl)`). However the image array rebuild (line 374–383) only prepends the variant image when `selectedVariant.imageUrl` exists, so resetting to 0 is safe. No bug but the guard condition check creates a subtle dependency.

### 3.4 Consistency

- Container: `mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8` — matches standard.
- Breadcrumb uses `/` separator (line 425, 445) while PLP uses an SVG right-chevron. **P2** — cross-page inconsistency in breadcrumb separators.
- **P2** — `RelatedProducts` uses `mt-16` (line 703) for the heading. All other section spacing on the PDP is `mt-6` or `mt-8`. The 16-unit top margin is unusually large and creates a disproportionate gap between the main product block and the recommendations.

### 3.5 Conversion/Ecommerce UX

- **P1** — Wishlist toggle (`handleToggleWishlist`) on line 279 shows a hardcoded English toast: `toastSuccess('Removed from wishlist', ...)` — not using `t()` for the title. On Arabic locale the toast title stays in English while the body is Arabic.
- **P1** — `effectiveInventory` (line 402) shows "In Stock" / "Out of Stock" for any non-zero inventory, but does NOT show quantity remaining. When `effectiveInventory` is low (e.g. 1 or 2), a scarcity signal would drive conversions. The quantity stepper already caps at `Math.min(effectiveInventory, 10)` but no "Only 3 left" message surfaces.
- **P2** — `FrequentlyBoughtTogether` and `YouMightAlsoLike` are gated on `isEnabled('upsell_crosssell')` AND `store.id !== 'demo'`. `ReviewSection` is gated on `isEnabled('reviews')` AND `layout?.reviewSection?.enabled` AND `store.id !== 'demo'`. These three blocks all sit below the FAQ accordion. On a fully-featured store with all flags on, the page has: main product → FAQ → Reviews → Frequently Bought Together → You Might Also Like → Related Products. This is a very long scroll with competing sections below the fold. No priority ordering or collapsible behavior.
- **P2** — The quantity stepper on line 578 has `min-w-11` on the `+` and `-` buttons but the container is `flex items-center rounded-lg border border-border` with no width constraint. On narrow mobile (390px) with a long variant selector above it, the stepper can crowd the "In Stock" label to the right edge.

### 3.6 A11y

- **P1** — `aria-label` on the wishlist button is hardcoded English (line 634): `aria-label={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}`. Not translated via `t()`. Arabic-locale screen reader users get English labels.
- **P2** — `aria-label` on thumbnail buttons is `"Select image ${index + 1} of ${images.length}"` (line 493) — English only, not translated.
- **P2** — `ProductFAQSection` accordion buttons have `aria-expanded` (line 83) — correct. But the expanded panel has no `id` and the button has no `aria-controls` pointing to it. The relationship between button and content is implied by DOM nesting only, not explicit.

---

## 4. Categories Page — `CategoriesClient.tsx`

### 4.1 Responsive Behavior

- **P2** — The skeleton fallback (lines 83–93) uses `grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6`. The real `T.CategoryGrid` uses per-template responsive column logic. On hydration the skeleton may be a different grid than the real content, causing layout shift.
- **P2** — No breadcrumb on this page, unlike Products, Cart, and PDP which all have breadcrumbs. Inconsistent navigation context.

### 4.2 Information Hierarchy & Scannability

- **P2** — When categories exist, the `<T.CategoryGrid>` renders with `title="Shop by Category"` hardcoded (line 74) — not pulled from `layout.categoriesPage`. The `catHeadingZone` zone styling is applied (`headingZone={scaleZone(catHeadingZone, catScale)}`), so typography customization works, but the title text itself is not customizable from the page-builder for the `/categories` page (only the homepage categories section title is configurable). The merchant cannot rename this page's heading.
- **P1** — The empty state (lines 59–69) shows a plain centered text block with no skeleton, no icon, and no visual treatment matching other empty states on the platform (e.g. Cart's centered icon + h2 + CTA pattern). The categories empty state is a `<div className="text-center py-12">` with just an `<h1>` and a link — low visual quality.

### 4.3 States

- **P1** — No loading state. The page renders an SSR-provided category list synchronously. If the SSR fetch fails and `categories` arrives empty, the empty state is shown with no indication that it's a data error vs. genuinely no categories. No retry available.
- **P2** — The skeleton (lines 83–93) only renders when `T && !templateLoading` is false — i.e. while the template components are loading client-side. The skeleton has no `aria-busy` or `aria-label` for screen readers.

### 4.4 Consistency

- Container: `mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8` — matches standard. No breadcrumb (see above).

### 4.5 Conversion/Ecommerce UX

- **P2** — The `T.CategoryGrid` here does NOT receive `seeAllHref` (compare: homepage version on line 399 passes `seeAllHref: storeUrl('/products')`). If the CategoryGrid template renders a "See All" link, it has no target on the categories page — potential dead link depending on the template.

### 4.6 A11y

- **P2** — The empty-state `<h1>` heading (line 62) renders even when the page is a data error, making a "Shop by Category" h1 appear for what is effectively an error page. The heading level is appropriate (h1 for the page), but the copy is misleading in the error scenario.

---

## 5. Cart — `CartClient.tsx`

### 5.1 Responsive Behavior

- **P2** — Cart layout: `mt-8 lg:grid lg:grid-cols-12 lg:gap-8` with items in `lg:col-span-8` and summary in `lg:col-span-4`. On mobile and tablet, summary renders BELOW the items list. On large orders this means the "Proceed to Checkout" CTA is far below the fold on mobile — shopper must scroll through all items before reaching the checkout button.
- **P2** — Cart item image is `h-28 w-28 ... sm:h-32 sm:w-32` (line 427). At 390px, 28 = 112px. The product name + price + quantity controls sit in `flex-1 flex-col` next to it. With a long product name (e.g. 40+ chars in Arabic), the name wraps into the price row area. No `line-clamp` on the product name.

### 5.2 Information Hierarchy & Scannability

- **P1** — On mobile, the "Order Summary" card (subtotal, discount, shipping, total, checkout CTA) renders AFTER the full item list (`mt-8 lg:col-span-4 lg:mt-0`). The stickiness (`sticky top-24`) only applies on desktop. Mobile shoppers see items → continue shopping → THEN the summary. The primary conversion CTA (checkout button) is below the fold unless the cart has ≤1 item.
- **P2** — Shipping cost shows `0 / Free` whenever `shippingLoaded` is false (line 268) — i.e. while the API call is in flight. The summary line reads "Shipping: Free" for a brief moment before the real fee loads. If the actual fee is non-zero, this creates a visible value change in the summary that may feel deceptive. A skeleton / "Calculating..." state would be cleaner.

### 5.3 States

- **P1** — There is no "removing" loading state when `handleRemoveItem` is called (line 127–135). The item disappears immediately via optimistic `removeCartItem`. If the API write fails silently, the item is gone from the UI but might still exist on the server. No re-sync or rollback on API failure.
- **P2** — `promoApplied` has no "Remove promo" button. Once applied, there is no UI path to remove the discount (sessionStorage key is set). The shopper is stuck with the promo until checkout or a page refresh wipes the session. Compare with the checkout `OrderSummary` which has `onRemoveCoupon` (line 1103).

### 5.4 Consistency

- Container: `mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8` — standard. Breadcrumb present.
- **P2** — Breadcrumb chevron uses the SVG right-chevron here (line 287) while PDP uses `/` — same inconsistency as PLP vs PDP.
- **P2** — `promo` confirmation line (line 758) in the fallback renders `"{promoCode.toUpperCase()} - {promoName} ({formatPrice(discount)} off)"` — English suffix "off" not translated. Theme `OrderSummary` version uses `t('off', 'خصم')` (line 675) — inconsistency between theme and fallback implementations.

### 5.5 Conversion/Ecommerce UX

- **P1** — Payment methods display (lines 904–914) is hardcoded to `['KNET', 'Visa', 'Mastercard', 'Apple Pay']` regardless of what the store has actually configured. A store using only MyFatoorah (no Apple Pay, no KNET) will still show Apple Pay and KNET badges — misleading trust signals.
- **P2** — Free shipping threshold message (lines 819–827): when `shipping === 0`, the cart shows `"Free shipping on orders over {freeShippingThreshold}"`. This renders even when the order already qualifies for free shipping (which is the condition for `shipping === 0`). The message should be "Your order qualifies for free shipping" in that case, or suppressed. As written, a shopper who meets the threshold sees both "Free" shipping AND a message saying "orders over X get free shipping" — redundant and slightly confusing.
- **P2** — `CartRecommendations` component (line 957–964) renders below the continue-shopping link. No heading context — shoppers who scroll past the cart see recommendations without any "You might also like" framing (this may be handled inside the `CartRecommendations` component itself, but it is not visible here).

### 5.6 A11y

- **P1** — Remove item button (line 483) has no `aria-label` — just a trash SVG icon. `aria-label="Remove item"` is present in the code (line 484) but it's generic — no product name. Screen readers will announce "Remove item" without context about which item. Should be `"Remove ${item.name} from cart"`.
- **P2** — Quantity stepper buttons use inline SVG without `aria-hidden` or `aria-label`. The `-` button (line 507) has `aria-label="Decrease quantity"` — correct. The `+` button (line 533) also has `aria-label="Increase quantity"` — correct. Both are present; acceptable.

---

## 6. Checkout — `CheckoutClient.tsx` (2-step: Shipping + Payment)

### 6.1 Responsive Behavior

- **P2** — Progress indicator (lines 798–844) uses `flex items-center justify-center` with a 64px wide connector line (`h-0.5 w-16`). On RTL the `ml-2` margin on step labels (lines 826, 840) is not mirrored to `mr-2` / logical `ms-2`. The label spacing will be wrong in Arabic layout (label sits on wrong side of the circle).
- **P2** — The form and order summary use `lg:grid lg:grid-cols-12 lg:gap-8` with form at `lg:col-span-7` and summary at `lg:col-span-5` (via `OrderSummary`). On mobile the order summary renders BELOW the form — same pattern as cart (summary after items). Acceptable for checkout (form-first), but the summary's coupon entry is also hidden below the form on mobile.

### 6.2 Information Hierarchy & Scannability

- **P1** — Step 1 (shipping form) shows no order summary by default on mobile. The shopper fills in their address without seeing what they are buying or the total. The `OrderSummary` component is rendered in the right column but on mobile it appears after the "Continue to Payment" button. A sticky mini-summary or collapsible order review at the top of the mobile form would reduce abandonment.
- **P2** — Phone field placeholder is `"+965 XXXX XXXX"` (line 919). The validation (lines 412–416) accepts `(965)?[24569]\d{7}$` — so `+965` prefix is accepted but the format hint suggests spaces which the validator strips. The mismatch is minor but the hint `+965 XXXX XXXX` (10 digits total after country code) doesn't match Kuwait's 8-digit local number format. Should be `+965 XXXX XXXX` = `+965` + 8 digits = correct, but visual formatting with spaces may confuse users who enter `96512345678` (rejected: 11 clean digits without `+`).

### 6.3 States

- **P1** — Loading state shows a full-viewport spinner (`flex min-h-[calc(100vh-4rem)]`) with no order context. If the page re-enters loading state after a payment failure and `!cartIsReady`, the shopper sees a blank spinner with no explanation. The loading state should at minimum keep the "Secure Checkout" chrome visible.
- **P1** — `checkoutError` (lines 689–750) renders as a string below the payment step form (in `PaymentStep`), but when `setStep(1)` is called after a VALIDATION_ERROR, the error message at the top of step 1 (`checkoutError`) does not clear automatically when the user starts editing. Stale error message persists until the next submit attempt.
- **P2** — Empty cart redirect (lines 770–790) uses `MinimalChrome` and renders a centered "Your cart is empty" message. The `<Button>` CTA goes to `/products` but the store's BottomTabBar and regular navigation are absent (MinimalChrome is stripped nav). The shopper is stranded in a sparse page with no way to browse categories or search.

### 6.4 Consistency

- Container: `mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8` — standard.
- **P2** — Checkout uses `MinimalChrome` (stripped header/footer) correctly to reduce distractions. This is intentional ecommerce convention (no exit navigation). Consistent with auth pages.

### 6.5 Conversion/Ecommerce UX

- **P1** — Email is optional (label "Email (optional)", line 938) and the validation only fires if non-empty (line 383). Kuwait e-commerce typically does phone-first. However, with no email, the customer receives no order confirmation email. There is no UI disclosure ("You won't receive an email confirmation") for shoppers who leave email blank. This is a trust issue — customers may expect an email receipt.
- **P2** — `selectedProvider` (line 173) is set to `paymentResult.data.defaultProvider` (line 330) if returned. But if the API returns no `defaultProvider`, `selectedProvider` stays as `''` and the shopper can submit step 2 without selecting a payment method (the `handleSubmit` at step 2 does not re-validate `selectedProvider`). The PaymentStep component presumably handles this visually, but a server-side empty `paymentMethod` in the order creation would fail with an uncaught error path.
- **P2** — "Return to cart" link (line 1057–1063) uses hardcoded `'← Return to cart'` in English and `'العودة إلى السلة →'` in Arabic. The direction arrows are correct but the English version hardcodes the Unicode left-arrow character rather than using an RTL-aware SVG icon — fragile if the font doesn't support that codepoint.

### 6.6 A11y

- **P1** — Step indicators (lines 808–844): the completed step 1 renders as a `<button>` with `aria-label` missing — just a checkmark SVG and "Shipping" text. No `aria-label="Step 1: Shipping (completed)"` or `aria-current`. Screen readers cannot identify step progress.
- **P2** — `data-error={!!formErrors.firstName}` on the wrapping div is not a standard ARIA attribute and does nothing for accessibility. The `aria-invalid={true}` on the `Input` component is the correct mechanism — it is used (line 875). The `data-error` attribute is only used by the scroll-to-first-error `querySelector` — fine, but it means the div has a non-semantic attribute that could confuse automated a11y audits.

---

## 7. Checkout Success — `SuccessClient.tsx`

### 7.1 Responsive Behavior

- **P2** — The order detail card uses `text-left` (line 115). On RTL/Arabic this will misalign content — order number, date, items, and total will all be left-aligned instead of right-aligned. Should be `text-start` (logical property) or conditionally `rtl:text-right`.

### 7.2 Information Hierarchy & Scannability

- **P2** — The "What's next?" timeline (lines 186–260) shows all 4 steps with only the first step highlighted (checkmark vs. clock icon). The visual distinction between "completed" (step 1, filled primary checkmark) and "pending" (steps 2–4, muted clock icon) is subtle — same size, similar color. Adding a filled vs. outlined treatment or a different color for "in progress" vs "future" would improve scannability.

### 7.3 States

- **P2** — When `!order?.items` (order fetch failed or no items), the success page shows a generic paragraph (lines 173–180) — no skeleton, no retry. The order number fallback shows `#${orderId.slice(0, 8)}...` which may look like a truncation error. A graceful "You can view your order in your account" message with a direct link would be cleaner.

### 7.4 Conversion/Ecommerce UX

- **P1** — After a successful purchase, `clearCart()` is called immediately in a `useEffect` (line 31). This fires before the order fetch completes. If `fetchOrder` fails, the shopper has no cart and no order details — they are left with just the success message and a truncated order ID. Recommend deferring `clearCart` until either (a) order is confirmed loaded, or (b) at minimum showing a loading state.

---

## 8. Search — `SearchClient.tsx`

### 8.1 Responsive Behavior

- **P2** — Search form uses `max-w-2xl mx-auto` on the input row — centered, but narrow on desktop. The product grid below uses `grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6` (via `T.ProductGrid columns={4}`) — full width. This creates a visual mismatch: centered narrow form above a full-width grid.
- **P2** — Loading skeleton (lines 390–395) uses `bg-muted animate-pulse rounded-lg h-64` with `grid-cols-4`. The real grid uses `T.ProductGrid` which may differ in aspect and column count per template. Layout shift on load.

### 8.2 Information Hierarchy & Scannability

- **P0** — The search input is NOT autofocused when navigating to `/search`. A shopper who taps the search icon in the BottomTabBar arrives at `/search` but must tap again to focus the input. Two-tap search entry is a friction point on mobile. `autoFocus` or `ref.current?.focus()` on mount would fix this.
- **P1** — The results count (line 400–413) reads `"{n} result{s} for "{query}"`. The pluralization logic `products.length !== 1 ? t('s', '') : ''` is English-only. In Arabic, the suffix `'s'` is suppressed (`t('s', '') = ''`) but Arabic has dual/plural forms — `1 نتيجة / 2 نتيجتان / 3+ نتائج`. The current implementation always renders just `"نتيجة"` regardless of count.
- **P2** — Filter panel (shown only after search) is `max-w-2xl mx-auto` while the results grid is full-width. Filters are visually disconnected from the content they control.

### 8.3 States

- **P1** — The empty-query state (lines 478–514) renders a search hint icon + "Search our products" + "Or browse all products." There is no search suggestions, no popular searches, no category shortcuts. On a fresh page load from the BottomTabBar "Search" tab, this is the default state — it is a dead screen with no guidance or shortcuts to popular categories/products.
- **P2** — The filters toggle (line 246) only appears `{committedQuery && ...}` — i.e. only when a search has been committed. If the shopper types in the box but hasn't submitted yet, they see no filter controls. They can't pre-narrow by category before searching. PLP allows category filter before search; search page does not.

### 8.4 Consistency

- Container: `mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8` — standard.
- **P2** — No breadcrumb on the search page, unlike Products page which has "Home > Products." The search page H1 is visible but without the Home link for back-navigation context.
- **P1** — Search uses `T.ProductGrid` (the theme grid, not `PecannbeeProductCard`). PLP uses `PecannbeeProductCard`. This means product cards on the search page may look and behave differently (different hover effects, different CTA button positions) from PLP — inconsistent shopping experience. PLP was deliberately migrated to `PecannbeeProductCard` for spec compliance; search page was not updated.

### 8.5 Conversion/Ecommerce UX

- **P2** — Sort options on search include `name-asc` ("Name A-Z") which is not available on the PLP. Conversely PLP has `featured` and `best_seller` which search does not. Inconsistent sort options between the two main product discovery paths.

### 8.6 A11y

- **P1** — Search form has `role="search"` (line 216) — correct. But the input has no `aria-label` or `id`+`<label>` association. The placeholder text `"Search for products..."` is the only labeling. Placeholder disappears when the user types — screen readers cannot identify the input's purpose after typing begins.

---

## 9. Wishlist — `WishlistClient.tsx`

### 9.1 Responsive Behavior

- **P2** — Uses `container mx-auto px-4` (line 172, 258) instead of the standard `mx-auto max-w-7xl px-4 sm:px-6 lg:px-8`. The `container` class in Tailwind is responsive-breakpoint-aware, but it may produce different max-widths than the explicit `max-w-7xl` used everywhere else — a subtle width inconsistency on large screens.
- **P2** — Share panel (lines 323–366) wraps buttons with `flex flex-wrap items-center gap-2`. On mobile at 390px, the WhatsApp and X buttons are small icon-only (text hidden with `hidden sm:inline`). The copy-link row truncates the URL with `truncate flex-1` — acceptable. But the three buttons + URL row may wrap awkwardly on very narrow screens.

### 9.2 Information Hierarchy & Scannability

- **P1** — The visibility toggle button (line 269) uses primary (filled) style for "Public" state and outline style for "Make Public." A filled primary button typically signals "this is the action to take." Here it means "this is the current state." Users expecting toggle behavior may interpret filled = CTA, not filled = active state. The semantics are inverted — filled should indicate the OFF/default state with the CTA to enable, or use a dedicated toggle/switch component.
- **P2** — No breadcrumb. Same gap as Categories page.

### 9.3 States

- **P1** — `isLoggedIn` state (line 37) is initialized to `false` but immediately set to `true` (line 77) before the API call completes. This means the unauthenticated state (lines 189–235) is never shown for a brief window — instead the loading skeleton shows. If the auth check fails and the user is truly unauthenticated, `setIsLoggedIn(false)` on line 56 sets it back — but after `setIsLoading(false)`. Race condition: there is a window where `isLoading=false && isLoggedIn=true` but `items=[]` — the empty wishlist state is shown briefly before the auth redirect renders.
- **P1** — `addToCart` (line 154) uses `api.addToCart(productId, 1)` and on success pushes to `/cart`. This bypasses the CartContext entirely — the cart count in the header/BottomTabBar will NOT update until the user navigates to the cart page and the context re-fetches. Inconsistent with the PLP and PDP which use `addItem()` from CartContext (which updates the count immediately).

### 9.4 Consistency

- **P1** — Container uses `container mx-auto` not `max-w-7xl` — inconsistent with every other page.
- **P2** — Loading skeleton uses `h-24 rounded-lg` list items (line 181) while other pages use card skeletons. Wishlist items render as a product grid — the loading skeleton shape doesn't match the loaded content shape.

### 9.5 Conversion/Ecommerce UX

- **P1** — "Add to Cart" from wishlist navigates immediately to `/cart` (line 161). On other pages, add-to-cart is non-navigating (shows a toast, user stays on page). The wishlist's navigation behavior is inconsistent and forces shoppers away from their wishlist after adding one item. Consider matching the non-navigating pattern.
- **P2** — No quantity selector on the wishlist grid — adds exactly 1 unit. For products where typical purchase quantity > 1 (e.g. grocery multibuy) this is a friction point.

### 9.6 A11y

- **P2** — Visibility toggle button has no descriptive label beyond its text content. For screen readers, `aria-pressed={isPublic}` or `aria-checked` would communicate the toggle state better than just the visual fill color.
- **P2** — "Retry" button on error (line 391) has no `aria-label` — just "Retry." Multiple retryable error states exist on the page; ideally `aria-label="Retry loading wishlist"`.

---

## 10. Account Area — Layout + Dashboard + Orders

### 10.1 Account Layout (`account/layout.tsx`)

**Responsive Behavior**

- **P1** — Sidebar (`lg:col-span-3`) is only visible at `lg:` and above. Below `lg:`, there is NO mobile navigation for the account area. The main content (`lg:col-span-9 lg:mt-0`) renders full-width below the hidden sidebar — but with no top tabs, no back button, and no hamburger menu to reach Dashboard/Orders/Addresses/Settings. A mobile user who deep-links to `/account/orders` is stuck on that page with no visible navigation to other account sections.
- **P2** — User avatar uses initials `{user?.firstName?.[0]}{user?.lastName?.[0]}` (line 89). If `firstName` or `lastName` is undefined (e.g. social auth with only an email), the avatar is blank. No fallback icon.

**Consistency**

- **P2** — Account navigation items are hardcoded in English (`'Dashboard'`, `'Orders'`, etc., lines 11–36) — not run through `t()`. Arabic locale users see English navigation labels in the sidebar.

**A11y**

- **P2** — Logout button (line 140) has `aria-label="Log out"` — correct. But the nav items have no `aria-current="page"` on the active item (only CSS class changes). Screen readers cannot identify which section is currently active.

### 10.2 Account Dashboard (`AccountDashboardClient.tsx`)

**Information Hierarchy**

- **P1** — "Total Orders" stat card shows `recentOrders.length` (line 125) — this is only the count of the last 3 orders (sliced at line 36 with `.slice(0, 3)`). A user with 50 orders will see "3 total orders" on their dashboard. This is factually wrong. Either fetch the full count separately or remove the "Total Orders" stat card.
- **P2** — "Saved Addresses" and "Wishlist Items" stat cards are hardcoded to `0` (lines 162, 189). The data is not fetched. These are placeholder cards that falsely show the user they have 0 saved data even if they have addresses and wishlist items. Either fetch real counts or remove these cards.

### 10.3 Orders List (`OrdersClient.tsx`)

**States**

- **P2** — "Track Order" button (line 231–237) is rendered for `shipped` / `delivered` orders but is `disabled` with `title="Tracking info not available yet"`. A disabled button with a tooltip is a poor UX pattern — the button implies a capability that doesn't exist. Should be hidden or replaced with a status label until tracking is implemented.

**Conversion/Ecommerce UX**

- **P1** — No reorder functionality. A "Reorder" CTA on delivered orders is a high-conversion feature for repeat customers (especially grocery/specialty food stores). The data is present (`order.items`).
- **P2** — Order status labels in `statusLabels` (lines 62–70) cover `pending/processing/shipped/delivered/cancelled`. If the API returns any other status (e.g. `refunded`, `on_hold`, `awaiting_payment`), the label falls back to `order.status.charAt(0).toUpperCase() + ...` — raw internal status string shown to the customer.

---

## 11. Auth Pages — Login (`LoginClient.tsx`)

### 11.1 Responsive Behavior

- Layout is well-contained: `w-full max-w-md` centered, `min-h-[calc(100vh-4rem)]`. Looks fine at 390px. No overflow concerns.

### 11.2 States

- **P2** — Error state (line 84) renders a `role="alert"` div with `text-sm text-destructive`. The error message is the raw API/JS error string (`err.message`). For invalid credentials the API likely returns a useful message, but network errors will show raw fetch/JS exception text.

### 11.3 Consistency

- Uses `MinimalChrome` — correct for auth pages (reduced distraction).
- **P2** — "Forgot password?" link (line 117–124) is `text-right`. In RTL/Arabic locale the `text-right` aligns correctly for LTR (password field is LTR-ordered), but the container doesn't apply `dir` — the `text-right` may visually conflict in full RTL layout.

### 11.4 Conversion/Ecommerce UX

- **P2** — No Google / social login. Kuwait-first, so Apple/Google are less critical, but for younger GCC users this creates friction. This is architectural, not a UX code issue, but worth noting.
- **P1** — After login, `syncCartToBackend()` is called (line 40). If cart sync fails, the error is caught by the outer `catch` block (line 47) and shown as a login error — even though login succeeded. A cart sync failure should show a separate, non-blocking warning rather than blocking the redirect.

### 11.5 A11y

- **P2** — Form uses `<Input label=...>` components which should render `<label>` internally. Confirm that `@ebda/ui` Input renders `htmlFor` correctly — not visible from this component but critical.
- **P2** — Error `role="alert"` is present — correct. The submit button uses `isLoading` prop for loading state — no `aria-disabled` verification visible but assumed handled by `@ebda/ui Button`.

---

## 12. Cross-Page Consistency Issues

| Issue                                                                                   | Affected Pages               | Priority |
| --------------------------------------------------------------------------------------- | ---------------------------- | -------- |
| Breadcrumb separator inconsistency: chevron SVG (PLP, Cart) vs. `/` text (PDP)          | PLP, Cart, PDP               | P2       |
| Missing breadcrumb entirely                                                             | Categories, Search, Wishlist | P2       |
| `container mx-auto` vs `max-w-7xl`                                                      | Wishlist                     | P1       |
| Account sidebar nav: English-only labels                                                | All account pages            | P2       |
| `T.ProductGrid` (search) vs `PecannbeeProductCard` (PLP) — inconsistent card appearance | Search, PLP                  | P1       |
| Sort options differ between PLP and Search                                              | PLP, Search                  | P2       |
| Loading skeleton column counts don't match real grid                                    | PLP, Search, Categories      | P2       |
| No mobile account nav below lg: breakpoint                                              | All /account pages           | P1       |

---

## Top 12 Highest-Impact Issues (Summary)

1. **P0 — Search input not auto-focused on mobile** (`SearchClient.tsx`): two-tap flow is serious friction on the primary discovery path.
2. **P1 — Mobile account area has no navigation below `lg:`** (`account/layout.tsx`): users on phones cannot navigate between Dashboard/Orders/Addresses/Settings.
3. **P1 — Cart checkout CTA below the fold on mobile** (`CartClient.tsx`): "Proceed to Checkout" button only appears after scrolling through all items + continue shopping link.
4. **P1 — Account Dashboard shows hardcoded-zero stats** (`AccountDashboardClient.tsx`, lines 162/189): "0 Saved Addresses" and "0 Wishlist Items" always, plus total orders is capped at 3.
5. **P1 — Search page uses `T.ProductGrid` not `PecannbeeProductCard`** (`SearchClient.tsx`): card appearance differs from PLP; spec migration was not applied to search.
6. **P1 — Homepage carousel add-to-cart ignores variant requirement** (`HomePageContent.tsx`, line 205): variant products added to cart without variant selection — incomplete SKU.
7. **P1 — PLP "Clear Filters" only resets search + category, not price/sort** (`ProductsClient.tsx`, lines 665–668): confusing 0-results dead end when price filter is active.
8. **P1 — Payment methods on cart hardcoded to KNET/Visa/MC/Apple Pay** (`CartClient.tsx`, lines 904–914): misleading trust badges for stores that don't support those providers.
9. **P1 — Wishlist add-to-cart navigates away + bypasses CartContext** (`WishlistClient.tsx`, line 161): cart count badge doesn't update; shopper is forced off the wishlist page.
10. **P1 — PLP no-results "Clear Filters" CTA incomplete** and **loading skeleton column mismatch causes layout jump** (`ProductsClient.tsx`): visible flicker between SSR and client rehydration.
11. **P1 — Checkout step 1 mobile: no order summary visible** (`CheckoutClient.tsx`): shopper fills address form without seeing total or items.
12. **P1 — Order list "Track Order" button always disabled** (`OrdersClient.tsx`, lines 231–237): dead UI element that signals a broken feature to customers.
