# Storefront Home Flow — Storefront Spec

**Goal:** clone the Storefront homepage **flow + image sizes + responsive behavior** across all 5 storefront templates (Modern, Classic, Minimal, Bold, Elegant). Colors stay tenant-driven via existing theme tokens — this spec is layout-only.

**Source:** https://www.demo-store.example/ (live, OSOSS-powered, RTL).
**Captured:** 2026-04-26 from Chrome at 1440×900 desktop and 390×844 mobile.

## 0. The flow in one paragraph

Top sticky header → autoplay full-bleed hero slider → 3-up category grid (square images with caption below, no overlay) → "New Arrivals" horizontal product strip → "Best Sellers" horizontal product strip → testimonial row → footer. Click a category and you land on a 6-up product grid with a right-side filter sidebar (sort, price-range slider, attribute checkboxes), each product card showing image, sold-out ribbon if applicable, wishlist heart, name, and a full-width add-to-cart pill.

## 1. Section sequence

Desktop total height ≈ 4520 px; mobile ≈ 2780 px.

| #   | Section            | Desktop | Mobile   | Notes                                                 |
| --- | ------------------ | ------- | -------- | ----------------------------------------------------- |
| 1   | Sticky header      | 64 px   | 56 px    | logo center, nav + cart on sides; hamburger on mobile |
| 2   | Hero slider        | 588 px  | 350 px   | 6 slides, autoplay ~5 s, pagination dots, no arrows   |
| 3   | Categories grid    | 2093 px | ~1400 px | 3 cols × N rows desktop; **2 cols mobile**            |
| 4   | New Arrivals strip | 302 px  | ~280 px  | horizontal scroll, dense small cards                  |
| 5   | Best Sellers strip | 427 px  | ~380 px  | horizontal scroll                                     |
| 6   | Customer reviews   | ~370 px | ~300 px  | testimonials                                          |
| 7   | Footer             | ~600 px | ~400 px  | logo, social, contact, copyright                      |

## 2. Image sizes — the part that matters

### 2.1 Upload contract (one rule)

**All product main images and category covers go in as ≥ 600×600 px square.** Storefront uses 630×630 for category covers and 600×600 for product main images. Squares scale cleanly to every breakpoint; non-squares break the grid. R2 + `next/image` handles the rendering.

### 2.2 Rendered sizes per breakpoint

| Surface                        | Mobile (≤640)   | Tablet (641–1023) | Desktop (≥1024)    | Aspect    | Radius                                 |
| ------------------------------ | --------------- | ----------------- | ------------------ | --------- | -------------------------------------- |
| Hero slide                     | 100vw × 350 px  | 100vw × 480 px    | 100vw × 588 px     | ≈2.45 : 1 | 0                                      |
| Category card image            | ~170×170 (2-up) | ~230×230 (3-up)   | **417×417** (3-up) | **1 : 1** | **20 px** (Modern); per pack otherwise |
| Product carousel card image    | 130×130         | 140×140           | **146×146**        | **1 : 1** | per pack                               |
| Product PLP card image         | ~165×165 (2-up) | ~190×190 (3-up)   | **168×168** (6-up) | **1 : 1** | **16 px** (Modern)                     |
| Product PLP card height (full) | ~340            | ~340              | **337 px**         | —         | **16 px** card                         |

`next/image sizes` attribute should be `(max-width: 640px) 50vw, (max-width: 1023px) 33vw, 25vw` for category cards, and `(max-width: 640px) 50vw, (max-width: 1023px) 33vw, 168px` for PLP cards.

## 3. Detailed section recipes

### 3.1 Hero — rotating banner

- 6 banner images, autoplay every ~5 s, pagination dots at bottom-center.
- Full-bleed (`width: 100vw`, no container padding).
- Aspect 2.45:1. Heights 350 / 480 / 588 px at three breakpoints.
- One CTA per slide, optional. No carousel arrows desktop or mobile (Storefront). Modern/Bold packs may add arrows on hover-capable devices.
- Touch swipe on mobile.
- Use `priority` on the first slide image; lazy-load the rest.

### 3.2 Categories grid — caption goes BELOW the image

This is the single most important correction from the first version of this spec. Reading the screenshot:

- Each card is **image + caption underneath**, not an overlay.
- Caption is the localized category name in body weight, centered.
- No icon, no description, no badge.

Layout:

- Section heading row at top: title at start (`المجموعات` / "Collections"), `عرض الكل` link at end. RTL: title at right, link at left.
- Grid:
  - **Desktop ≥1024:** 3 columns. Card image 417×417, ~24 px gap.
  - **Tablet 641–1023:** 3 columns, image scales to ~230×230.
  - **Mobile ≤640:** 2 columns. Image ~170×170. (Confirmed by Storefront's mobile reflow.)
- Card body:
  - Square image, 1:1, **20 px radius on the image itself**.
  - Caption directly below the image, ~14–16 px gap, centered, body font weight per pack.
  - No border, no card background, no shadow at rest. Subtle hover scale 1.02–1.05 (Modern/Bold) or no hover transform (Minimal/Elegant).
- Card count: 10 categories on Storefront → 4 desktop rows (last row has 1 card). Don't pad with empty slots.

### 3.3 Horizontal product strips — "New Arrivals" + "Best Sellers"

Two identically-shaped sections. Difference is data source only.

- Heading row identical to categories.
- Single row of square 146×146 image cards on desktop, scrolling horizontally; user swipes/scrolls to reveal more.
- Storefront shows 6–8 cards in view at 1440 desktop; aim for **6 visible at desktop, 4 at tablet, 2.5 at mobile** (the half card hints at scrollability).
- Card body: image only on Storefront. **Our version must show name + price under the image** — Storefront hides them with a global CSS rule (B2B feel). See § 5.
- Snap-scroll for nicer feel: `scroll-snap-type: x mandatory` on the strip, `scroll-snap-align: start` on each card.
- RTL: scroll direction flips automatically with `dir="rtl"`. Verify with `?lang=ar`.

### 3.4 Testimonials

- Heading "آراء العملاء" / "Customer Reviews".
- 3-up review cards on desktop (★★★★★ + Arabic/English quote + author + city), single carousel on mobile.
- Pull from `Review` table where `status === 'published'` and `rating >= 4` and `verified === true`. Limit 6, randomize per page load.
- Empty state: hide the entire section (don't show a placeholder).

### 3.5 Footer

Logo + copyright + social icons + contact (phone, email) + "Powered by [tenant brand]". Standard.

## 4. Category PLP (Product List Page) — ref screenshot #2

Click a category card → land here. Desktop 1440 viewport.

### 4.1 Layout

- **Right-side filter sidebar** (RTL): `width: ~280 px`, sticky on desktop.
- **Left-side product grid:** 6 columns on desktop.
- Page title at the top of the content column ("الحلويات العربية" — the category name).

### 4.2 Filter sidebar (right column on RTL)

Sections, top to bottom:

1. **ترتيب** ("Sort") — dropdown. Options: المضاف حديثاً / السعر: من الاقل... / السعر: من الأعلى... / الافضل مبيعا.
2. **فلاتر** ("Filters") header with **إزالة الفلاتر** ("Remove filters") action button.
3. **مجال السعر** ("Price range") — dual-handle slider with EGP min/max display (3.000 د.ك → 6.000 د.ك).
4. **الحجم** ("Size" / attribute facet) — checkbox list (185 جرام / 500 جرام).
5. Additional attribute facets stack below as needed.

Mobile: filters collapse into a bottom-sheet modal triggered by a "Filters" button at the top of the grid. Sort stays as a top-bar dropdown.

### 4.3 Product card

| Property            | Value                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- |
| Card width × height | **168 × 337 px** desktop                                                                |
| Card background     | `--card`/white                                                                          |
| Card border-radius  | **16 px**                                                                               |
| Card border         | 1 px subtle (Modern/Classic); 2 px hard (Bold); none (Minimal); 1 px hairline (Elegant) |
| Card padding        | 0 around image, ~12 px around text/CTA                                                  |
| Card layout         | image area on top, name middle, CTA at bottom — vertical flex column                    |

Inside the card (top to bottom):

1. **Image area** — square 168×168, 1:1, **same radius as card top corners** (16 px), beige `bg-muted` background. Image is `object-contain` on a tinted backdrop.
   - **Top-start (RTL right):** wishlist heart icon, white circular bg, ~32 px tap target.
   - **Top-end (RTL left):** sold-out ribbon if `inventory === 0`. Red ribbon, white text "نفدت الكمية" / "Sold out". Diagonal banner OR straight rectangular pill — both work; Storefront uses a straight pill.
2. **Product name** — 1–2 lines, body weight, line-height tight. `text-balance` for cleaner wrapping. Truncate on overflow with ellipsis at 2 lines.
3. **CTA button** — full-width pill, `border-radius: 9999px`, ~40 px tall, brown `bg-primary` with white text + cart icon.
   - Default: `إضافة للسلة` / "Add to cart" — `bg-primary`.
   - Sold out: `نفدت الكمية` / "Sold out" — `bg-muted text-muted-foreground`, disabled.
   - View only (e.g., variants must be picked): `عرض` / "View" — `bg-primary` (same brown).

### 4.4 Grid responsiveness

- Desktop ≥1280: **6 columns**, sidebar 280 px on right.
- Tablet 768–1279: **3–4 columns**, sidebar collapses to top filter bar.
- Mobile ≤768: **2 columns**, filters in bottom-sheet.

## 5. Deliberate deviations from Storefront

These are places we should NOT clone:

1. **Show product name + price on every card.** Storefront uses CSS to hide product prices everywhere on the storefront (`.new-product-box-small .product-price { display: none !important; }`). That's a B2B / "request quote" pattern. Our default is B2C — keep prices and sale strikethroughs visible.
2. **Add a sale-percentage chip** (top-end of image, e.g., `-25%`) when `compareAtPrice > price`.
3. **Quick-add behavior** — clicking "إضافة للسلة" on the PLP card adds default variant to cart and shows a slide-in toast. Don't navigate away on add.
4. **JSON-LD `Product` schema** on PLP. Already part of our SEO sweep.
5. **Skip the testimonial section** unless real reviews exist (≥4★, verified). Don't ship hardcoded fake quotes.

## 6. New `TemplateComponents` surfaces

| Surface                                              | Status                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `T.HeroSlider({ slides, autoplayMs })`               | exists per pack — confirm 6-slide support, autoplay default 5000 ms, pagination dots                                         |
| `T.CategoryGrid({ categories, columns })`            | exists — adjust default to **3 desktop / 2 mobile**, **caption-below-image** layout, square 1:1 image, 20 px radius (Modern) |
| `T.ProductCarousel({ products, title, seeAllHref })` | **NEW** — horizontal scroll, snap, 146 px square cards, 6/4/2.5 visible per breakpoint                                       |
| `T.SectionHeading({ title, action })`                | **NEW** — shared "title-at-start, action-at-end" header used by categories + carousels + reviews                             |
| `T.TestimonialRow({ testimonials })`                 | **NEW** — 3-up desktop, 1-up swipe carousel mobile, hides if empty                                                           |
| `T.ProductGridCard`                                  | exists — extend with sold-out ribbon, wishlist heart in top-start, full-width CTA pill                                       |
| `T.FilterSidebar({ filters })`                       | exists for category PLP — confirm right-side RTL, sticky, mobile bottom-sheet variant                                        |

## 7. Per-template adaptations (voice contracts intact)

Structure is shared; styling varies per pack. **Do not break the existing voice contracts in `apps/web/src/templates/<pack>/DESIGN.md`.**

| Element               | Modern                    | Classic                  | Minimal                        | Bold                             | Elegant                             |
| --------------------- | ------------------------- | ------------------------ | ------------------------------ | -------------------------------- | ----------------------------------- |
| Hero overlay          | gradient + parallax       | centered logo overlay    | image only                     | massive uppercase headline       | asymmetric crop, 500 ms transitions |
| Category card radius  | **20 px**                 | 0 (sharp)                | 0 (no chrome)                  | 0 + 2 px frame                   | 0 + 1 px hairline                   |
| Category caption      | sans-serif body 600       | serif 700                | sans-serif 400 lowercase       | sans-serif 900 uppercase tracked | serif 200 letter-spacing 0.1em      |
| Product carousel card | 16 px radius, soft shadow | sharp border, table-feel | image-only chrome-free         | 2 px border + uppercase name     | hairline border + serif name 300    |
| PLP card radius       | **16 px**                 | 0 (sharp)                | 0 (no chrome)                  | 0 + 2 px frame                   | 0 + 1 px hairline                   |
| CTA pill              | rounded-full + cart icon  | sharp 4 px radius button | underline-only link, no chrome | hard square button uppercase     | hairline pill, serif label          |
| Sold-out ribbon       | red rectangular pill      | red sharp banner         | gray text only, no ribbon      | black rectangular slab uppercase | hairline strike-through over name   |

Hard rules to keep (cribbed from existing DESIGN.md):

- **Elegant:** never `font-bold/extrabold/black`; weight range 200–500.
- **Bold:** never `shadow-sm`; hard contrast only.
- **Minimal:** no card backgrounds / borders / shadows.
- **Classic:** sharp borders, formal serifs.
- **Modern:** rounded corners, soft shadows, hover lifts.

## 8. Implementation phases (ship one at a time)

1. **Audit** current home composition per pack — diff against this section sequence.
2. Land **`T.SectionHeading`** + replace inline heading rows.
3. Land **`T.ProductCarousel`** wired to `/public/products?sort=newest&limit=16` and `?sort=best_seller&limit=12`.
4. **Tune `T.CategoryGrid` defaults** per § 3.2 (3-up desktop, 2-up mobile, caption below image, 1:1 square image, 20 px radius for Modern).
5. **Extend `T.ProductGridCard`** with sold-out ribbon + wishlist heart in top-start + full-width CTA pill (per pack).
6. **Confirm `T.FilterSidebar`** matches § 4.2 — right-RTL, sticky desktop, bottom-sheet mobile.
7. **Land `T.TestimonialRow`** wired to `Review` model (≥4★, verified, limit 6). Hide if empty.
8. **Per-pack home composition** to match the section sequence in § 1.

Each phase is independently shippable. Browser-verify both `?lang=ar` and `?lang=en` per the Ebda Store convention before merging.

## 9. References

- `apps/web/src/templates/<pack>/DESIGN.md` — voice contracts, must read before extending any template.
- `~/design-systems/awesome-design-md/` — 59 brand DESIGN.md references.
- `docs/superpowers/specs/2026-04-23-storefront-template-coverage-phase-1-design.md` — `ShopChrome` / `MinimalChrome` wrappers.
- `docs/superpowers/specs/2026-04-23-phase-2-template-contract-extension-design.md` — `ProductCard` callbacks pattern.
- Source screenshots: home (categories with captions visible) + category PLP (Arabic Sweets) — provided by Ahmad 2026-04-26.
