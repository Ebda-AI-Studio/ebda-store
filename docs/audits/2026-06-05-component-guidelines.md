# Component Guidelines Audit — 2026-06-05

**Scope:** Product cards (all render paths), Headers (5 themes), Footers, Hero components, CartTable/OrderSummary (5 themes), CartClient, CheckoutClient.

**Method:** Read-only static analysis. No changes made.

---

## Priority Legend
- **P0** — blocks user journeys, legal/a11y compliance failure, revenue risk
- **P1** — significant UX regression or a11y failure affecting real interactions
- **P2** — polish / best-practice gap, no hard user impact

---

## 1. Product Cards

### 1.1 PecannbeeProductCard (`apps/web/src/templates/shared/PecannbeeProductCard.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| PC-1 | P1 | 341–355 | **Touch targets** | The `View` CTA `<Link>` for variant products has no explicit `min-h-[44px]`. The `Add to Cart` `<button>` (line 362–405) correctly has `min-h-[44px]` but the `View` link sibling does not. Customers on variant products get a sub-44px target. |
| PC-2 | P2 | 250 | **Tabular nums** | The sale chip (`-25%`) and prices use no `tabular-nums` / `font-variant-numeric: tabular-nums`. Price digits shift width as values change. |
| PC-3 | P2 | 279 | **text-wrap: balance** | `line-clamp-2` is present but `textWrap: 'balance'` is applied only via inline style (line 281, merchant override path). The base Tailwind class has no balance/pretty fallback for non-merchant-overridden cards. However, the inline `style={{ textWrap: 'balance' }}` at line 281 overrides everything so this is addressed _unless_ the merchant override suppresses it via `productNameZone`. Low risk — document for awareness. |
| PC-4 | P2 | 206–229 | **Touch-action on wishlist** | Heart button inside a scrollable image area has no `touch-action: manipulation`. On slow-tap iOS the 300ms delay can cause a double-trigger or scroll conflict. |
| PC-5 | P2 | 154 | **Focus ring on image link** | `focus:outline-none focus-visible:ring-2 focus-visible:ring-primary` — correct. No offset ring, which means the ring draws inside the image box. Add `focus-visible:ring-offset-2`. |
| PC-6 | P1 | 103 | **CLS — above-fold images** | Primary product image uses `fill` with `sizes` (good) but no `priority` prop. On the PLP (above fold on mobile) this means the first 4–8 cards fire lazy fetches, causing CLS as the aspect containers re-paint. Should accept and propagate a `priority` prop for the first N cards. |

### 1.2 ProductCarousel (`apps/web/src/templates/shared/ProductCarousel.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| PC-7 | P1 | 193–196 | **A11y — aria-label direction bug** | Prev arrow `aria-label` is `isRtl ? 'التالي' : 'Previous'`. "التالي" = "Next" in Arabic, but this is the PREV arrow. The RTL label is inverted. Same bug on next arrow (line 218). Screen reader users hear the opposite direction. |
| PC-8 | P1 | 505–517 | **Touch targets — CTA** | The carousel CTA uses `block w-full text-center cursor-pointer ${styles.productCardCta}`. The pack styles (`pack-styles.ts`) drive padding; if a pack provides minimal padding the CTA can be under 44px tall. No `min-h-[44px]` guard on the carousel CTA. The variant `View` link and OOS button have the same gap. |
| PC-9 | P2 | 386 | **Touch-action on quick-add circle** | Quick-add `+` button (E3 overlay) lacks `touch-action: manipulation`. |
| PC-10 | P2 | 323–324 | **Tabular nums on prices** | Same as PC-2 — no `font-variant-numeric: tabular-nums`. |
| PC-11 | P1 | 317 | **CLS — primary carousel image** | First carousel image has no `priority` prop. The homepage "New Arrivals" / "Best Sellers" section is above-fold on most devices. Should accept a `priority` prop and apply it to the first card slot (index 0). |
| PC-12 | P2 | 241 | **Carousel list semantics** | The `<ul>` / `<li>` structure is correct. However the `<ul>` has no `aria-label` or containing `<section aria-label>`. Assistive technologies won't announce "product list" context for this widget. |

### 1.3 Modern ProductCard (`apps/web/src/templates/modern/ProductCard.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| PC-13 | P0 | 113–114 | **CLS — above-fold image** | First image uses `loading="lazy"`. On the homepage "Related Products" grid or PLP, cards 1–4 are above fold. Lazy-loading the primary image causes layout shift. The card should accept a `priority` prop and use it for above-fold slots. |
| PC-14 | P1 | 179–205 | **Touch target — wishlist button** | `w-9 h-9` = 36×36px. WCAG 2.5.5 recommends ≥44×44px. The modern wishlist button is 36px and therefore below the minimum touch target. |
| PC-15 | P2 | 99 | **Focus ring — card link** | No `focus-visible:ring` on the main card `<Link>`. The link wraps the entire card, so keyboard tab hits a large invisible target with no visible ring. |
| PC-16 | P2 | 112 | **Sizes attribute too broad** | `sizes="(max-width: 640px) 100vw, ..."` for a card that is at most 220px wide. Over-fetching on mobile. Should be `(max-width: 640px) 50vw, ...` for 2-up grids. |

### 1.4 Elegant ProductCard (`apps/web/src/templates/elegant/ProductCard.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| PC-17 | P1 | 252–253 | **Truncation** | Product name uses `line-clamp-1` — single line clamp. Long Arabic names (common in Kuwait grocery/food) get hard-truncated with no ellipsis visible in the Tailwind line-clamp rule on small card widths. Elegant's `text-xs tracking-[0.15em]` makes this worse. Consider `line-clamp-2`. |
| PC-18 | P1 | 139–142 | **CLS — all images lazy** | Both primary AND hover images use `loading="lazy"`. No `priority` support. |
| PC-19 | P2 | 161–163 | **Focus ring missing** | Wishlist button `p-2 min-h-[44px] min-w-[44px]` — good size — but no `focus-visible:ring` or `focus-visible:outline` class. Missing keyboard indicator. |

### 1.5 Classic ProductCard (`apps/web/src/templates/classic/ProductCard.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| PC-20 | P1 | 101–109 | **CLS — lazy primary image** | `loading="lazy"` on primary image. No priority support. |
| PC-21 | P2 | 181 | **Heading class without text-wrap** | `<h3>` for product name has `leading-snug tracking-tight` but no `text-wrap: balance` for preventing widows on short names. Minor on cards. |
| PC-22 | P2 | 77–81 | **No focus ring on card link** | The outer `<Link>` wrapping the card has `group block cursor-pointer` but no `focus-visible:ring-*`. |

### 1.6 Minimal ProductCard (`apps/web/src/templates/minimal/ProductCard.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| PC-23 | P0 | 150–181 | **Mobile CTA inaccessible** | The quick-add overlay is `hidden lg:flex` — completely hidden on mobile/tablet. No alternative cart affordance on the card for non-desktop viewports. Customers on touch devices must navigate to PDP to add items. This is an intentional design choice per comments ("desktop converts faster, mobile stays pure") but it is an accessibility/conversion gap for all 320px–1023px users: they have no path to "Add to Cart" without clicking through. |
| PC-24 | P1 | 114–119 | **CLS — lazy primary image** | `loading="lazy"`. No priority prop. |
| PC-25 | P2 | 189–190 | **Truncation** | Name has `leading-snug` but no `line-clamp-*`. Long names will overflow the flex column, pushing the price below. |

### 1.7 Bold ProductCard (`apps/web/src/templates/bold/ProductCard.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| PC-26 | P1 | 103–114 | **CLS — lazy primary image** | `loading="lazy"`. No priority prop. |
| PC-27 | P2 | 183 | **line-clamp-1** | `line-clamp-1` for name — single line. Same as Elegant (PC-17), Arabic products with long names get cut. |
| PC-28 | P2 | 79 | **hover:-translate combined with translate-x/y** | The bold card uses `hover:translate-x-1 hover:-translate-y-1` which both apply at hover. The combination is intentional (brutal / neobrutalist effect) — **not a bug**, intentional theme identity. |

---

## 2. Headers

### 2.1 Modern Header (`apps/web/src/templates/modern/Header.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| H-1 | P1 | 248 | **Mobile search bar hidden** | `data-zone="mobile-search"` wrapper uses `class="hidden"` — permanently hidden. The intent is to have a persistent mobile search row, but the class removes it entirely. Search is unavailable on mobile outside the drawer. All 5 themes have this same bug (see below). |
| H-2 | P2 | 59 | **Hard-coded colors** | `bg-white/80 dark:bg-gray-900/80` bypasses the theme token system. Should be `bg-background/80`. Visible brand inconsistency on non-default-white themes. |
| H-3 | P2 | 265–266 | **Search input missing explicit label association** | Desktop expandable search uses `aria-label` on the `<input>` — that's correct. However the mobile search `<input>` at line 265–270 also has `aria-label` but since the wrapper is permanently hidden (H-1), this is dormant. |
| H-4 | P2 | 328 | **Mobile drawer role** | The drawer `<div>` has `aria-label` (good) but no `role="dialog"` or `role="navigation"`. Screen readers won't announce it as a modal/dialog when it opens. |

### 2.2 Elegant Header (`apps/web/src/templates/elegant/Header.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| H-5 | P1 | 248 | **Mobile search hidden** | Same as H-1 — `class="hidden"` on mobile search wrapper. |
| H-6 | P2 | 151–153 | **Search button missing `aria-expanded` state** | Elegant's search button has `aria-label` but no `aria-expanded={isSearchOpen}`. Screen readers can't track toggle state. Modern and Bold headers have this correctly. |

### 2.3 Classic Header (`apps/web/src/templates/classic/Header.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| H-7 | P1 | 293 | **Mobile search hidden** | Same as H-1. |
| H-8 | P0 | 258–286 | **Mobile cart button invisible** | The mobile cart button at lines 258–286 has class `hidden md:inline-flex`. On mobile screens the cart is only accessible via… nowhere in the header. No hamburger-drawer account/cart shortcut is rendered. The bottom tab bar handles cart on mobile, but this is worth flagging — if BottomTabBar is disabled or the merchant hides it, cart is unreachable on mobile. |
| H-9 | P1 | 179–183 | **Search button touch target** | Classic desktop search button (`onClick` → focus) has NO `h-11 w-11` sizing. It's a bare `<button>` with only `cursor-pointer` class — potentially under 44×44px. |
| H-10 | P2 | 202–221 | **Account/Cart links no touch target enforced** | Desktop account/cart `<Link>` elements have no explicit `h-11 w-11` container. They rely on the parent `flex items-center gap-4` which gives natural height but no minimum width guarantee. |

### 2.4 Minimal Header (`apps/web/src/templates/minimal/Header.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| H-11 | P1 | 226 | **Mobile search hidden** | Same as H-1. |
| H-12 | P1 | 59–62 | **Auto-hide on scroll with no reduced-motion guard** | Header auto-hides on scroll down (`-translate-y-full`) without checking `prefers-reduced-motion`. The slide animation itself is not problematic but auto-hiding navigation without a fallback means keyboard/AT users scrolling down lose the header permanently until they scroll up. This creates a navigation gap that Motion Sensitivity users experience as unpredictable UI disappearance. |
| H-13 | P2 | 189–190 | **Cart badge tiny text** | Cart count renders as bare `text-[9px]` unstyled text (no badge box), making it hard to read. All other themes use a styled pill badge. |

### 2.5 Bold Header (`apps/web/src/templates/bold/Header.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| H-14 | P1 | 204 | **Mobile search hidden** | Same as H-1. |
| H-15 | P2 | 99–103 | **Search button missing `type="button"`** | The search toggle `<button>` at line 99 has no `type="button"` attribute. Inside a form it would default to `type="submit"`. While no form wraps this button, the pattern is fragile. Bold and Classic both miss `type="button"` on some icon buttons. |

### Cross-theme Header Summary

**H-1 is a P1 bug in all 5 themes.** The `data-zone="mobile-search"` container is always `class="hidden"`, rendering the mobile persistent search bar permanently invisible. This was presumably an intermediate development state. Restoration requires removing the `class="hidden"` and re-testing the mobile layout flow.

---

## 3. Footers

### 3.1 Modern Footer (`apps/web/src/templates/modern/Footer.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| F-1 | P2 | 115–121 | **`<img>` instead of Next.js `<Image>`** | Footer logo uses `<img>` (native HTML, no optimization). Next.js `<Image>` would auto-generate srcset + WebP. Applied consistently across all 5 footers (see below). |
| F-2 | P2 | 143 | **Social link aria-label = icon key** | `aria-label={s.key}` where `s.key` is likely an internal ID string (e.g. `"instagram"`, `"twitter"`). Should be a human-readable label: `aria-label={`Visit us on ${s.key}`}` or the social network's branded name. |
| F-3 | P2 | 336 | **Newsletter `<input>` no `id`** | The email `<input>` in the newsletter form has `aria-label` but no `id` for explicit `label/for` pairing. While `aria-label` covers the screen reader case, convention and WCAG success criterion 1.3.1 prefers explicit `<label for>`. |
| F-4 | P2 | 170–200 | **Footer link touch targets** | Footer navigation links use `text-sm` text with `space-y-2.5` gap (≈10px). On mobile with fat-finger precision, adjacent links in the list become hard to hit without explicit `min-h-[44px]` or larger `py-` values. |

### 3.2 Bold Footer (`apps/web/src/templates/bold/Footer.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| F-5 | P2 | 71–75 | **`<img>` not `<Image>`** | Same as F-1. |
| F-6 | P1 | — | **No newsletter in Bold** | Bold footer intentionally omits newsletter (see comment at line 36). This is a theme identity decision, **not a bug** — documented for completeness. |

### Cross-theme Footer Summary

All 5 footer themes use `<img>` for the footer logo (F-1). The social link `aria-label` pattern is shared across all themes (F-2).

---

## 4. Hero Components

### 4.1 HeroBanner (`apps/web/src/templates/shared/HeroBanner.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| HB-1 | P1 | 99–101 | **`<picture>` + `<Image fill>` conflict** | A `<picture>` element wraps a Next.js `<Image fill>`. `<Image fill>` generates its own `<img>` element with `srcset`; the outer `<source media="(max-width: 639px)">` competes with Next.js's own responsive processing. The browser reads the `<source>` first and may serve the mobile URL at any viewport without applying Next.js resizing. The mobile-specific image will NOT be processed by Next.js's image pipeline (only the `src` of the `<Image>` component is). This means the mobile image serves at original full resolution. |
| HB-2 | P2 | 99 | **Alt text on hero** | `alt={alt}` where `alt` defaults to `''` (empty string, line 31). Empty alt means screen readers announce the image as decorative. Merchants who set a meaningful `alt` are fine, but the default being empty is a gap: if the banner image carries informational content (product photo, sale imagery), screen readers skip it entirely. Should default to `headline` when `alt` is not set. |
| HB-3 | P2 | 119–128 | **Overlay heading not an `<h1>` or `<h2>`** | The headline text inside `styles.heroHeadline` is wrapped in what `pack-styles.ts` decides — if the pack renders a `<p>` instead of a heading element, the document heading order breaks. Needs auditing in pack-styles. |

### 4.2 Modern Hero (`apps/web/src/templates/modern/Hero.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| HB-4 | P1 | 43–46 | **`h1` heading styles** | The `<h1>` uses inline `letterSpacing: '-0.02em'` while also having Tailwind `tracking-tight`. Both declarations target the same CSS property — inline style wins. The Tailwind class is dead weight but not harmful. Minor inconsistency. |
| HB-5 | P2 | 136–143 | **Image with fill but no `priority`** | The hero section with image (`if (image)` branch) has `priority` on the `<Image>` — correct. The no-image branch has no image at all. Good. |

---

## 5. CartTable (all themes)

### 5.1 Modern CartTable (`apps/web/src/templates/modern/CartTable.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| CT-1 | P2 | 73 | **Tabular nums on prices** | `{format(item.price)}` — price spans no `tabular-nums`. Decimal digits shift when price changes. |
| CT-2 | P1 | 83 | **focus-visible ring offset missing** | Qty decrease button: `focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1` uses `ring-offset-1` (4px) which is minimal. Works but could be tighter against the border. Not a blocker. |

### 5.2 Elegant CartTable (`apps/web/src/templates/elegant/CartTable.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| CT-3 | P2 | 52–55 | **Name link no min-height** | Name `<Link>` in cart row has no `min-h-[44px]`. On mobile with one-word product names the tappable area can be under 44px tall. |
| CT-4 | P2 | 86 | **Qty display not announced** | The `<span>` showing quantity has no `aria-live` or `role="status"`. When the qty updates programmatically, screen readers don't announce the new value. |

### 5.3 Classic CartTable (not found separately — uses fallback in CartClient)

Classic theme did not export a named CartTable component in the file list. CartClient falls back to its inline cart rows when `T.CartTable` is undefined. The fallback at CartClient lines 419–570 has:

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| CT-5 | P0 | 483–486 | **Remove button `aria-label` not localized** | `aria-label="Remove item"` — English-only. No `isRtl` check. Affects Classic + any theme missing a CartTable component when AR locale is active. |
| CT-6 | P1 | 507–530 | **Qty stepper labels English-only** | `aria-label="Decrease quantity"` and `"Increase quantity"` — English-only in the CartClient fallback. |

### 5.4 Bold CartTable (`apps/web/src/templates/bold/CartTable.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| CT-7 | P2 | 45–46 | **Empty `<Link>` image fallback** | When `item.image` is falsy, the `<Link>` image area renders nothing (no fallback). An accessible user navigating via tab lands on an empty link with no visual target. Should render a placeholder. |

### 5.5 Minimal CartTable (`apps/web/src/templates/minimal/CartTable.tsx`)

Same as Elegant (CT-4): qty `<span>` has no `aria-live`.

---

## 6. OrderSummary

### 6.1 Modern OrderSummary (`apps/web/src/templates/modern/OrderSummary.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| OS-1 | P2 | 43 | **`aria-live` scope too broad** | `<dl aria-live="polite">` wraps the entire price breakdown. Every subtotal/shipping re-render (e.g. on promo code apply) announces the whole breakdown again. Should scope `aria-live="polite"` to only the total/discount delta rows. |
| OS-2 | P2 | 82–88 | **Tabular nums on prices** | All `fmt()` calls produce prices without `tabular-nums`. The "Total" row especially would benefit (`text-xl font-bold text-primary`). |
| OS-3 | P1 | 92–118 | **CTA `<Link>` has `aria-disabled` but is not truly disabled** | `aria-disabled={ctaDisabled}` on a `<Link>`. `aria-disabled` does NOT prevent navigation — the link still responds to Enter/click. Should be `pointer-events-none` + `tabIndex={-1}` when disabled, or use a `<button>` instead of `<Link>` for the disabled state. |

---

## 7. Cart Page (`apps/web/src/app/cart/CartClient.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| C-1 | P1 | 282–295 | **Breadcrumb chevron no `aria-hidden`** | The chevron SVG in the breadcrumb has no `aria-hidden`. Screen readers may announce "svg" or a blank character between "Home" and "Shopping Cart". |
| C-2 | P2 | 724–726 | **Apply promo button no `type="button"`** | The `<button>` for applying the promo code inside `T.OrderSummary` children at line 643–650 has no `type="button"`. Inside a form, `type` defaults to `submit`. This button is rendered as a child of `T.OrderSummary` (not in a `<form>`), so low risk — but the sibling button at line 721 which IS inside the fallback summary `<div>` (wrapped in no form) is also missing `type="button"`. Fragile if a future form wrapper is added. |
| C-3 | P1 | 510 | **Qty stepper: `h-8 w-8` remove button** | Fallback CartClient remove button is `h-8 w-8` = 32×32px, below 44px minimum. |
| C-4 | P2 | 562–566 | **Item total price — tabular nums** | `formatPrice(item.price * item.quantity)` in the total column has no `tabular-nums`. |

---

## 8. Checkout Page (`apps/web/src/app/checkout/CheckoutClient.tsx`)

| # | Priority | Line | Rule | Issue |
|---|---|---|---|---|
| CH-1 | P2 | 800–845 | **Progress step counter color contrast** | The inactive step circle uses `bg-muted text-muted-foreground`. On themes where muted is a light grey, the number "2" may have insufficient contrast against the muted background (< 4.5:1). No hard failure without measuring the theme values, but worth a contrast check. |
| CH-2 | P2 | 825–827 | **`ml-2` directional class** | Step label uses `ml-2` (not `ms-2`). This breaks RTL layout — the label will still be on the left of the step circle in Arabic. Should be `ms-2` (logical margin). |
| CH-3 | P2 | 826, 842 | **Same `ml-2` on both step labels** | Both "Shipping" and "Payment" step labels use `ml-2`. In RTL mode both will be left-misaligned from their circles. |
| CH-4 | P1 | 1028–1051 | **`<label htmlFor="order-notes">` but textarea uses `id="order-notes"`** — this specific one IS correctly paired. However the `<Input>` / `<Select>` components from `@force/ui` are used without `id` props (lines 867, 890, 913, 936, 961, 996, 1018). Without an explicit `id` on each input, the `<label>` rendered inside `<Input>` can only use an internal generated id if the component auto-generates one. Need to verify `@force/ui`'s `<Input>` component generates stable matching ids. |
| CH-5 | P1 | 795 | **No `noValidate` on checkout form** | The `<form onSubmit={handleSubmit}>` at line 851 relies on custom JS validation. Without `noValidate`, the browser's native HTML5 validation fires first and can produce English-only browser bubbles that conflict with the app's custom AR/EN error messages. |

---

## 9. Cross-theme Consistency Analysis

### Intentional theme divergence (not bugs)

| Difference | Themes | Assessment |
|---|---|---|
| Portrait 3:4 image vs square 1:1 | Elegant/Classic use `aspect-square sm:aspect-[3/4]`; Bold uses `aspect-square` always | Bold's always-square is intentional streetwear identity |
| Wishlist button always-visible on touch vs hover-reveal | Modern, Elegant, Bold show on touch; Classic/Minimal have no wishlist button | Classic/Minimal missing wishlist button is a feature gap, not theme identity |
| Hover quick-add overlay vs hidden-on-mobile | Minimal hides entirely on mobile; others show on all viewports | Intentional for Minimal (per code comment) — see PC-23 |
| Name `line-clamp-1` vs `line-clamp-2` | Elegant + Bold use 1-line; others 2-line | Intentional for those themes but creates UX issue for long Arabic names |
| Sale chip color | Bold shows discount% badge on image; Classic shows corner badge; Elegant shows "Sale" text badge | Intentional flavor differences |
| Header height | Modern/Bold: `h-32 md:h-44`; Elegant: flexible py-6; Classic: py-5; Minimal: py-3 | Intentional proportional differences |

### Probable bugs disguised as theme differences

| Difference | Themes affected | Assessment |
|---|---|---|
| Mobile search always `class="hidden"` | ALL 5 themes | Bug — see H-1 |
| CTA `View` link missing `min-h-[44px]` | PecannbeeProductCard + all carousel cards | Bug — same code path, not theme intent |
| `loading="lazy"` on every primary product image | All 5 theme ProductCards | Bug — no `priority` prop support propagated |
| Social icon `aria-label` = raw key string | All 5 footers | Bug |
| `ml-2` instead of `ms-2` in checkout progress | CheckoutClient (shared) | Bug |

---

## Summary of Most Impactful Violations (Top 10)

1. **[P1, ALL 5 THEMES] Mobile search bar permanently hidden** — `class="hidden"` on `data-zone="mobile-search"` in all 5 Header components. Mobile users have no inline search. Affects every store on every mobile visit. (`modern/Header.tsx:248`, `elegant/Header.tsx:248`, `classic/Header.tsx:293`, `minimal/Header.tsx:226`, `bold/Header.tsx:204`)

2. **[P1, ALL 5 THEME PRODUCTCARDS + SHARED CARDS] No `priority` prop on primary product images** — All 5 theme ProductCards and both shared cards (PecannbeeProductCard, ProductCarousel) use `loading="lazy"` on the primary image with no mechanism to pass `priority` for above-fold slots. Causes CLS on PLP, homepage carousels, and related-products sections. (`modern/ProductCard.tsx:113`, `elegant/ProductCard.tsx:140`, `classic/ProductCard.tsx:108`, `minimal/ProductCard.tsx:115`, `bold/ProductCard.tsx:103`, `shared/ProductCarousel.tsx:317`)

3. **[P1, ProductCarousel] Prev/Next aria-labels inverted in RTL** — The "Prev" arrow gets `aria-label="التالي"` (= "Next") and vice versa. Screen reader users navigating the carousel in Arabic get wrong direction announcements. (`shared/ProductCarousel.tsx:195–218`)

4. **[P1, Modern ProductCard] Wishlist button 36×36px** — Below the 44px minimum touch target. Affects all stores using the Modern theme (the default). (`modern/ProductCard.tsx:182`)

5. **[P1, HeroBanner] `<picture>` + `<Image fill>` conflict** — The `<source media="(max-width:639px)">` inside a Next.js `<Image fill>` wrapper bypasses Next.js image optimization for the mobile source URL. Mobile image is served at original full resolution, not resized/WebP. (`shared/HeroBanner.tsx:95–102`)

6. **[P0, Minimal ProductCard] No Add-to-Cart affordance on mobile/tablet** — The quick-add CTA is `hidden lg:flex`, meaning 320px–1023px users have zero inline cart action. They must navigate to PDP for every add. A deliberate choice per code comments but a confirmed revenue gap on the Minimal theme. (`minimal/ProductCard.tsx:151–152`)

7. **[P1, CartClient fallback] Remove/qty buttons English-only `aria-label` + sub-44px remove button** — CartClient's fallback cart rows (used when a theme doesn't export CartTable) has `aria-label="Remove item"` / `"Decrease quantity"` / `"Increase quantity"` with no Arabic, and the remove button is `h-8 w-8` (32px). (`apps/web/src/app/cart/CartClient.tsx:483, 514, 537`)

8. **[P1, CheckoutClient] `ml-2` physical margin on progress steps** — Both step labels use `ml-2` (not `ms-2`). In RTL/Arabic mode step labels are misaligned. Affects every Arabic checkout. (`apps/web/src/app/checkout/CheckoutClient.tsx:826, 842`)

9. **[P0/P1, OrderSummary] `aria-disabled` on a `<Link>` doesn't prevent navigation** — `aria-disabled={ctaDisabled}` on the checkout CTA `<Link>` in ModernOrderSummary is non-functional. A disabled `<Link>` still navigates on Enter/click. (`apps/web/src/templates/modern/OrderSummary.tsx:96`)

10. **[P2, ALL FOOTERS + PRODUCT CARDS] Missing `tabular-nums` on prices** — All price displays across all 5 themes and shared cards omit `font-variant-numeric: tabular-nums`. When prices update (qty change, promo apply), digit widths shift causing micro-jitter. High-frequency user impact on cart/checkout pages.
