# Storefront Typography — Consistent Measure (2026-06-05)

One yardstick applied to **every** storefront page (Home, PLP, PDP, Cart, Checkout,
Categories, Search, Account) across all 5 themes. Produced with the UI/UX stack
(web-design-guidelines = Vercel web-interface-guidelines + the adopted modular scale).
Source of truth for "what size should this be?" — reference it on every storefront UI change.

## The measure (the standard)

**Type scale — Major Third 1.25:** `12 · 14 · 16(base) · 20 · 24 · 30 · 36 · 48`.

- **16px is the floor for real reading content** (product names, prices, descriptions, body) — Arabic legibility.
- **12px (`text-xs`) only for micro-labels**: badges, kickers/eyebrows, tax notes, chips. Never a panel/section title, price, product name, or input.
- **No arbitrary `text-[Npx]`** on SHARED components — it wins specificity over the per-store CSS-var emitter and silently no-ops merchant zone overrides (rules #7/#13). _Exception:_ per-theme micro-type that is the theme's signature voice (see "Intentional voice" below).
- **Form inputs ≥16px** (prevents iOS zoom-on-focus). Never shrink inputs on `sm:`/`lg:`.

**Role → size band (consistent across all 5 themes — theme voice comes from weight / tracking / font-family, NOT size):**

| Role                                                  | Band                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Page H1 / PDP product name                            | text-3xl–4xl (28–36)                                                             |
| Homepage section heading (New Arrivals, Best Sellers) | text-2xl→responsive (hero-level, OK large)                                       |
| Secondary / "you may also like" strip heading         | text-lg–xl (18–20) — **not** homepage scale                                      |
| Section subtitle                                      | ≤ text-base (16), clearly below its heading                                      |
| Card product name                                     | text-sm–base (14–16)                                                             |
| Card price                                            | text-base (16), distinct via weight/color or one step up                         |
| Cart/summary panel title                              | text-base (16)                                                                   |
| Cart row label                                        | text-sm (14); value text-base–lg (16–18); Total value up to text-xl–2xl by voice |
| Micro-label / badge / kicker / tax                    | text-xs (12)                                                                     |
| Body / description                                    | text-base (16), line-height ≥1.5                                                 |

**Vercel web-interface-guidelines (also enforced):** `tabular-nums` on every price/quantity/count;
`text-balance`/`text-pretty` on headings/subtitles; `focus-visible:ring` on every interactive el;
`line-clamp`/`truncate` + `min-w-0` on flex text; semantic `<button>`/`<label>`/`<table>`;
`aria-live` on async totals; 44px min touch targets.

## What was fixed this pass (commit batch 2026-06-05)

| Page(s)                               | Fix                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All sections + PDP related            | `SectionHeading` subtitle `text-xl`(20)→`text-base`(16) + `text-pretty` — was nearly as large as its heading                                                                    |
| PDP related strip                     | cards `cardSize="sm"`(200px) → `"xs"`(160px) genuinely compact; heading capped at 20px (`relatedHeadingZone`) unless merchant sets a PDP heading zone — was 24px homepage-scale |
| Cart OrderSummary (classic + elegant) | panel + total headings `text-xs`(12)→`text-sm`(14) — were dwarfed by 20px values                                                                                                |
| PLP cards (all 5 packs)               | brand-primary frames (prior commit)                                                                                                                                             |
| PLP filters                           | divider/border lines → primary tints (prior commit)                                                                                                                             |
| Shared cards (cross-theme)            | badge/kicker arbitrary-px → `text-xs`: PecannbeeProductCard, ProductCarousel, BlogCarousel, TrustStrip, ProductListItem, `getProductCardTextSizes('xxs')`                       |
| PLP card / list / account             | `tabular-nums` added on prices/counts missing it                                                                                                                                |

## Deferred — judgment calls (NOT bugs; left intentionally)

- **Intentional theme voice (do NOT convert):** elegant + minimal + classic micro-type
  (`text-[9px]`/`[10px]`/`[11px]` nav links, eyebrows, cart-count badges, AnnouncementBar,
  Footer headings) is each theme's canon per its `DESIGN.md` (minimal = "smallest type system",
  elegant = editorial eyebrows at 10–11px). Converting these would erase theme identity.
- **Checkout OrderSummary** rows (`apps/web/src/app/checkout/OrderSummary.tsx`) are coherent
  (title 18 / rows 14 / total 18) — auditor over-reported; left as-is.
- **PLP filter section headings** (`text-lg`) + category chips (`lg:text-lg`) — acceptable; not changed.
- **minimal CategoryCard** label `text-xs` — conflicts with its pack token (`text-base`) but is
  the minimal voice; flagged, left to avoid breaking identity. Revisit if Ahmad wants it bumped.
- **Cross-theme Total-value drift** (modern/elegant 20px, classic/minimal 18px, bold 24px) — intentional voice.

## Remaining a11y backlog (correctness, separate from typography — not yet done)

- `focus-visible:ring` missing: HeroSlider pagination dots, "See all" link, blog card link, search submit button.
- Touch targets <44px: ProductCarousel quick-add (`h-10`), search filter selects (`lg:h-10`), account nav/sign-out, Pecannbee `<Link>` CTA min-height.
- `aria`: pagination buttons (no `type`/`aria-label`/`aria-current`), checkout progress steps (no nav role/`aria-current`), checkout totals (no `aria-live`), icon-only buttons (remove-coupon, dismiss-error) missing `aria-label`.

These don't affect the typographic measure; schedule as an a11y pass.
