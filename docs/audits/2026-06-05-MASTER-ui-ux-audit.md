# Storefront UI/UX Audit — Master Report (2026-06-05)

Comprehensive UI/UX audit of the FWB storefront (apps/web + 5 themes), run with
**web-interface-guidelines**, **UI UX Pro Max** (99 UX rules), and **frontend-design**.
**Top priority per the owner: ratios — typographic scale, layout proportions, and
section rhythm.** Four detailed sub-reports back this summary:

- [`typography-ratios.md`](./2026-06-05-typography-ratios.md)
- [`layout-section-ratios.md`](./2026-06-05-layout-section-ratios.md)
- [`component-guidelines.md`](./2026-06-05-component-guidelines.md)
- [`page-by-page-ux.md`](./2026-06-05-page-by-page-ux.md)

---

## 1. THE RATIO SYSTEM (the headline)

Today the storefront uses **17 distinct font sizes (9–96px)** and **off-grid spacing**
(`py-14`, `py-24`, `gap-5`, `gap-7`, `gap-1.5`) with no single modular system. Pages
disagree on container width, H1 size, section rhythm, and card aspect. The fix is to
adopt ONE scale for type, ONE for spacing, and standard layout ratios — then map every
role to it.

### 1a. Typographic scale — Major Third (1.25)

| Step | px | Tailwind | Storefront role |
|---|---|---|---|
| caption | 10 | `text-[10px]` | badges, tax labels (only allowed arbitrary size) |
| label | 12 | `text-xs` | kicker chip, footer nav heads |
| small | 14 | `text-sm` | CTAs, meta, announcement bar |
| **body** | **16** | `text-base` | product names, prices, descriptions ← BASE/floor |
| lead | 20 | `text-xl` | subtitles, feature copy |
| h3 | 24 | `text-2xl` | transactional page H1, sub-sections |
| h2 | 30 | `text-3xl` | PLP/PDP/Cart H1, section heading (sm+) |
| h1 | 36 | `text-4xl` | hero mobile, section heading (desktop) |
| display | 48–72 | `text-5xl…7xl` | hero (sm→lg); bold pack may go `text-8xl` |

**Kill the `text-[22px]` phantom step** (all 5 packs, `pack-styles.ts`) → `text-2xl`.
**16px is a hard floor** for any real content text. Body line-height 1.5–1.75; headings
tighter but **never below 1.1 for Arabic** (bold's `leading-[0.9/0.95]` clips glyphs).

### 1b. Spacing scale — 8pt

- **Allowed section padding:** `py-8 · py-12 · py-16 · py-20` (drop `py-14`, `py-24`).
- **Section rhythm (homepage bands):** `py-12 sm:py-16 lg:py-20` — uniform.
- **Transactional page wrapper:** `py-8`.
- **Allowed grid gaps:** `gap-2 · gap-3 · gap-4 · gap-6 · gap-8` (drop `gap-1.5/5/7/10`).

### 1c. Layout ratios

- **Container (every page):** `mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8` — no `container`.
- **Cart & Checkout:** both **8/4** (currently Cart 8/4, Checkout 7/5 — inconsistent).
- **PDP:** gallery/info **5/7** (currently 50/50, snaps abruptly at `lg` with no `md`).
- **Card aspect (shared carousel/PLP):** `aspect-square sm:aspect-[3/4]` to match 4/5 themes
  (today carousels + PLP fall back to `aspect-square` → same product looks different per surface).

---

## 2. Cross-cutting P0 / P1 (beyond ratios)

**P0 — fix first**
- **`tabular-nums` is used NOWHERE.** Every price/total across cart, checkout, PDP, cards
  jitters and misaligns on quantity/promo updates. Add `font-variant-numeric: tabular-nums`
  to all monetary text. (Highest-frequency, whole-funnel.)
- **Minimal theme has no add-to-cart on mobile/tablet** (`minimal/ProductCard.tsx:151`,
  `hidden lg:flex`) — confirmed revenue gap for every Minimal-store phone shopper.
- **Homepage carousel add-to-cart ignores variant requirement** (`HomePageContent.tsx:205`)
  — can push an incomplete SKU into the cart.

**P1 — high impact**
- **Mobile inline search hard-hidden on all 5 themes** (`*/Header.tsx` `data-zone="mobile-search"` `hidden`).
- **No `priority` on above-fold product images** (all 7 card components) → CLS on PLP + carousels.
- **Carousel prev/next `aria-label` inverted in RTL** (`ProductCarousel.tsx:195`).
- **Wishlist button 36px** in Modern (`modern/ProductCard.tsx:182`, `w-9 h-9`) < 44px target.
- **Cart fallback: English-only aria-labels + 32px remove button** (`CartClient.tsx:483,514,537`).
- **Checkout step labels use `ml-2` (physical) → RTL break** (`CheckoutClient.tsx:826,842`).
- **`aria-disabled` on `<Link>` doesn't block navigation** (theme OrderSummary CTAs).
- **PLP skeleton 3-col vs real 6-col → layout jump** (`ProductsClient.tsx`).
- **"Clear Filters" only resets search+category**, not price/sort (`ProductsClient.tsx:665`).
- **Cart payment icons hardcoded** KNET/Visa/MC/ApplePay regardless of store providers.
- **Account area: no mobile nav**; dashboard shows hardcoded `0` for addresses/wishlist.
- **Uncapped prose** (PDP description, BrandStory) — add `max-w-prose` (65–75ch).

**P2**
- `text-wrap: balance`/`pretty` on headings (widows).
- `touch-action: manipulation` + intentional tap-highlight on interactive elements.
- Heading-order + focus-visible consistency sweep.

---

## 3. Recommended execution order

1. **Ratio system foundation (P0):** unified type scale + 8pt spacing + container/column/aspect
   standardization. This is the owner's #1 ask and removes the bulk of "things look off."
   Land it shared-first (`pack-styles.ts`, `card-size.ts`, `getProductCardTextSizes`,
   `SectionHeading`, page containers) so all 5 themes + all pages inherit it.
2. **tabular-nums everywhere** (one shared price utility/class).
3. **Per-theme revenue/a11y P1s:** mobile search, image `priority`, RTL aria-labels, touch
   targets, Minimal mobile add-to-cart, checkout RTL margins.
4. **Page UX P1s:** PLP skeleton parity, Clear Filters, account mobile nav, dashboard data,
   carousel variant guard.
5. **P2 polish** + per-theme identity sharpening (Phase 2 of the demo program — each template
   gets its distinct, on-scale treatment).

Each step lands shared/platform-level so every store + every demo inherits it. Verify on the
4 demo URLs (`store.forcemediakw.com/demo-{modern,classic,minimal,bold}`) + wadyaljuz (elegant)
at mobile (≤390) and desktop (≥1280) after each batch.
