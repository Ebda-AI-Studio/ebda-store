# FWB Storefront UI/UX Refresh — Plan

**Date:** 2026-05-17
**Status:** Sprint 1 GO — Stitch preview in flight (2026-05-17 afternoon)
**Trigger:** Friend feedback on wadyaljuz.com today + UI catalog of three Kuwait reference storefronts — **all three on OSOSS platform** (FWB's direct competitor). Synthesis play: take the best of each and apply to FWB.
**Companion specs:**

- `~/Desktop/projects/_design-systems/fashion-smej.DESIGN.md` — future-use fashion store spec
- `~/Desktop/projects/_design-systems/fwb-platform-sprint1.DESIGN.md` — **active** Sprint 1 target driving Stitch generation
- `reference-ui-target-pecannbee-bankalkahraman.md`, `reference-ui-untitled-smej.md`

## Decisions locked 2026-05-17 (Ahmad)

| Bucket                         | Decision                                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1 two-tone background**     | **Admin opt-in** per store. Three presets: `warm-sand` (default if enabled), `cool-grey`, `pure-white-minimal`. NOT a forced platform change.                                                                                |
| **Section dividers**           | **Platform default, always-on.** Even on pure-white-mode stores, sections get the new padding rhythm + section title anchors. Color shift adds visual depth when enabled; rhythm carries when not. NO `<hr>` lines anywhere. |
| **A2/A3 (padding + anchors)**  | Yes — platform default                                                                                                                                                                                                       |
| **B (font:card ratio table)**  | Yes — codify in `design.md`                                                                                                                                                                                                  |
| **Stitch preview before code** | Yes — generate Sprint 1 homepage preview to validate visual direction before Tailwind work                                                                                                                                   |
| **C/D/E buckets**              | Decide AFTER Sprint 1 visual lands                                                                                                                                                                                           |

---

## Stitch Sprint 1 preview — RESULTS (2026-05-17, 14:33)

Generated 3 screens against design system `assets/df079217951141e9bbd04a894d978dce` using Gemini 3.1 Pro. Files in `~/Desktop/projects/_design-systems/stitch-sprint1-preview/`.

| #   | Title                                                        | Dims      | Files                                            |
| --- | ------------------------------------------------------------ | --------- | ------------------------------------------------ |
| 1   | Wady Aljuz Homepage — Mobile                                 | 780×7052  | `1-mobile-generic.{png,html,rationale.md}`       |
| 2   | Wady Aljuz Homepage — Desktop                                | 2560×7742 | `2-desktop.{png,html,rationale.md}`              |
| 3   | Wady Aljuz **Improved** Homepage — Mobile (vs current state) | 780×7170  | `3-mobile-wady-improved.{png,html,rationale.md}` |

### What Stitch confirmed works visually

1. **Alternating warm-sand backgrounds (#FAF7F2 ↔ #F0EAE0) DO carry section separation without `<hr>` lines.** Verified across all 3 screens — sections feel distinct even with zero divider strokes. This validates the core "color shift IS the divider" thesis.
2. **Hero portrait 3:4 on mobile preserves brand calligraphy fully.** Compared to the cropped landscape today, the generated version shows the full Arabic title with breathing room.
3. **Oxblood `--accent` (#2D1418) CTA pills sit elegantly against the warm tints** — no contrast/visibility issues. Confirmed for `Add to Cart`, `View`, and bottom-nav active state.
4. **Bottom tab bar with elevated cart pill** reads correctly and doesn't fight the page-level CTAs.
5. **Section title kicker (EN uppercase) + bold Arabic title + "عرض الكل" link** scans cleanly as a heading anchor — addresses friend complaint #1 directly.
6. **48px mobile / 80px desktop section padding** is enough breathing room without feeling sparse. Don't go bigger.

### New patterns Stitch surfaced that weren't in the original plan

1. **Active bottom-tab uses soft `--accent`-tinted pill background**, not just an icon color change. Makes the active state more tactile. → Add to bucket D1 spec.
2. **Brand story block reads better with image on TOP and Arabic body below on mobile** (vertical stack) than side-by-side. Side-by-side reserved for desktop. → Confirms the responsive split.
3. **Trust strip works as 3 horizontal items on mobile too** (not just stacked vertical) when icons are 28px and titles are 12px. Saves vertical real estate. → Open question for bucket D2: stacked vs horizontal on mobile?
4. **Hero subtitle in white needs a subtle dark gradient at the bottom** for legibility against varied imagery. Stitch added this automatically. → Add to spec for `HeroBanner`.
5. **Product card "NEW" badge is too easy to miss at small sizes.** Stitch's first pass put it as a small pill — barely visible at 140px card width. Recommendation: bump to 14px text, bolder weight, larger pill padding (8px horizontal, 3px vertical). → Refine bucket C2 spec.

### Things to refine vs Stitch's output before implementation

1. Stitch occasionally over-applied border-radius. **Cap card radius at 8px**, button radius at 999px (pill). Round corners further look toy-ish.
2. Stitch used image-thumbnail-style products on Screen 3. For Wady Aljuz specifically, **on-surface product photography (jar on wooden surface)** reads more "premium grocery" than packshots. Source images matter as much as the layout.
3. Bottom tab bar should NOT have a chat-bubble FAB on top of it — keep that as a separate floating element if used at all.

### How to use the previews

- **PNGs:** open `~/Desktop/projects/_design-systems/stitch-sprint1-preview/*.png` in Preview for visual review
- **HTMLs:** open in any browser for interactive view + DevTools inspection — these are raw Stitch outputs and can be cherry-picked for Tailwind class patterns when implementing
- **Rationales:** `*.rationale.md` — Stitch's own commentary on each generation

These are NOT production HTML; they're spec validators. Treat them as a target reference Ahmad can point at while reviewing the eventual real implementation.

---

## What we know — the three friend complaints

Translated from Ahmad's report:

1. **"No separators between sections"** — hero merges into categories, categories merge into the rest of the page. The eye can't tell where one section ends and the next begins.
2. **"Fonts as a ratio with the cards"** — type size relative to card size is off. With the recent typography bumps and card-size changes, the proportion looks wrong.
3. **"Product cards are static, no visuals"** — cards feel inert. No motion, no badges, no overlays, no hover micro-payoff.

These are subjective, but every one maps to a concrete, fixable gap when cross-checked against Pecannbee/SMEJ.

---

## What we observed — the three reference storefronts

All three reference sites are Kuwait-market storefronts on the same OSOSS platform. Side-by-side patterns FWB doesn't have today:

**Sectioning + rhythm:**

- SMEJ uses a warm sand background (`#E8E0D4`) everywhere; product/category cards are white surfaces that _lift_ off the sand. The background color shift IS the section separator.
- Pecannbee uses a cream background (`#F5F0E8`) plus generous vertical padding (~64–96px between sections).
- Both reference sites alternate two background tones for adjacent sections (no horizontal `<hr>` rules — color shift carries the rhythm).

**Typography ratio:**

- Section headings: 22–28px bold (FWB recently bumped here, ✓)
- Product names on cards: 14–16px medium (FWB needs spot-check against current card height)
- Hero EN overlay: 36–56px editorial serif

**Product card visual interest:**

- Brand pill badge top-left (SMEJ overlays "SMEJ" green pill)
- Out-of-stock diagonal ribbon top-left (Pecannbee — red ribbon, not just a grey button)
- Wishlist heart top-right (FWB ✓)
- Quick-add (+) circle overlay on horizontal carousel cards (Bank Alkahraman pattern)
- Compare-at strikethrough price inline before regular price
- "NEW" badge for items <14 days old

**Other surfaces FWB doesn't have:**

- Mobile sticky bottom tab bar (Home / Wishlist / Cart / Search) — all three references have this
- Trust/USP grid section on homepage (Pecannbee 2×2, SMEJ 3-up)
- Blog/article carousel + CMS for posts (SMEJ uses this for content marketing)
- Brand story / Vision inline block on homepage
- PDP share row (X / Facebook / Telegram / WhatsApp)
- PDP spec table (key-value rows)
- Email + phone in footer (both refs surface these prominently)
- Language toggle inside hamburger (vs FWB's top-header position)

---

## What Stitch unlocks

Google Stitch MCP (just installed, 14 tools — see `~/.claude/projects/-Users-ahmadsharaf/memory/reference-stitch-mcp.md` once written) lets us:

1. **Upload a `DESIGN.md` → create a Stitch design system** (already done for fashion-SMEJ; can do another for the FWB platform default)
2. **Generate full screens from text prompts** that respect the design system — much faster than hand-coding Tailwind for each variant
3. **Generate variants** of an existing screen along specific aspects (layout / color / images / text/font)
4. **Iterate via `edit_screens`** — keep the same screen, change one aspect at a time

This means we can prototype the section-rhythm + product-card visual fixes in Stitch _before_ we touch FWB code — get visual alignment with Ahmad in a day, then implement only the picked direction.

---

## Proposed direction (for discussion — pick / cut / reorder)

### Bucket A — Section rhythm + visual breathing (addresses complaint #1)

A1. **Two-tone homepage background.** Add `--bg-page` (warm tint) and `--bg-section-alt` (slightly deeper) to the platform CSS-vars. Alternate adjacent sections. White stays only for the product/category card surfaces. _Per-store overridable_ via the existing brand-color settings.

A2. **Section vertical padding bump.** Today FWB sections sit tight. Bump to `py-12 md:py-20` (48px mobile / 80px desktop) between every homepage block. Section heading → first content row: `mt-6 md:mt-8`.

A3. **Stronger section title anchors.** Every section starts with: kicker label (12px uppercase) + main title (22–28px bold) + optional subtitle (15px regular muted). Today FWB's `SectionKicker` is there — verify it's wired on every block (categories, new-arrivals, best-sellers, blog when added, trust strip when added).

A4. **Remove visible horizontal rules between sections.** Color shift + breathing room IS the divider. No `<hr>`, no border-top.

### Bucket B — Typography:card ratio (addresses complaint #2)

B1. **Audit current product card text sizes against card dimensions** in all 3 render paths (`PecannbeeProductCard`, 5 theme `ProductCard`s, `ProductCarousel`). The post-2026-05-13 typography bump may have over-corrected for headings while leaving card text too small relative to the card itself.

B2. **Lock a card-size:font-size pair table:**

- Card width `sm` (140–160px) → name `text-xs` (12px), price `text-sm` (14px)
- Card width `md` (180–200px) → name `text-sm` (14px), price `text-base` (16px)
- Card width `lg` (220–260px) → name `text-base` (16px), price `text-lg` (18px)
- This becomes a platform rule similar to `feedback-fwb-sizing-rules.md`.

B3. **Document the rule** in `design.md` (repo root) so future card-size changes auto-update text sizes.

### Bucket C — Product card visual interest (addresses complaint #3)

C1. **Out-of-stock diagonal ribbon** — terracotta corner ribbon overlaid top-left of image when `inventory === 0`. Replaces the current grey-button-only state. Platform-level (PecannbeeProductCard + 5 theme cards + carousel = 7 files per the FWB platform rule).

C2. **"NEW" badge** — small red/accent pill top-left when `createdAt > 14 days ago` OR `isNew === true`. Same 7 files.

C3. **Compare-at price inline** — strikethrough 12px before the regular price when `compareAtPrice > price`. FWB has this on PecannbeeProductCard; verify on the 5 theme cards.

C4. **Hover micro-payoff (desktop only):** image scales `1.02` over 300ms ease-out; card border-radius softens by 2px. Tiny, but it kills the "static" perception.

C5. **Brand pill badge (optional, opt-in per store):** if `store.showBrandBadge === true`, overlay store name top-left of every product image. Useful for stores with strong brand recognition (SMEJ pattern).

### Bucket D — New surfaces (medium effort, addresses observed gaps)

D1. **Mobile sticky bottom tab bar** — Home / Wishlist / Cart (primary, elevated) / Search. New shared component `BottomTabBar.tsx`, wired into the storefront `ShopChrome`. Behavior: hide on PDP, show on listing/home/cart/account. ~3 days.

D2. **Trust/USP strip homepage section** — new `TrustStrip` component, 3-up icons + title + subtitle. Merchant-editable via admin layout page. ~2 days.

D3. **PDP share row** — `ShareProductRow` component (X / Facebook / Telegram / WhatsApp / copy-link). ~1 day.

D4. **PDP spec table** — key-value rows from `product.specifications` JSON. Admin form already may support this; verify. ~1 day.

D5. **Email + phone in footer** — pull from `store.email` / `store.phone`. ~30 min.

D6. **Language toggle inside hamburger** — move from top-header to hamburger. ~1 hour.

### Bucket E — Long-term content surfaces (>1 week each, future bets)

E1. **Blog module** — new `BlogPost` schema in Prisma + `/blog` route + admin CMS for posts + `BlogCarousel` component on homepage. Significant. Defer unless Ahmad wants it now.

E2. **Brand story / Vision block** — merchant-editable homepage content block (image + text). Lighter than blog. ~3 days.

E3. **Quick-add (+) circle overlay** on horizontal carousel cards — Bank Alkahraman pattern. Single-tap add-to-cart on carousels. ~2 days.

### Bucket F — Stitch as accelerator (process, not feature)

F1. **Upload `fashion-smej.DESIGN.md` to Stitch** (already drafted). Generate the 10 screen list from the DESIGN.md to have a visual reference catalog of what a fashion-vertical FWB store _could_ look like.

F2. **Write `fwb-platform.DESIGN.md`** — the same spec but for the existing FWB defaults (Pecannbee-flow primitives). Upload to Stitch. From there, prompt for variants of the homepage applying buckets A–C above. Pick the winner, implement.

F3. **Use Stitch `edit_screens` for the typography/card-size A/B** — generate 3 variants of the new-arrivals carousel with different card-text size pairs (bucket B2). Show Ahmad, pick, implement.

---

## Suggested execution order (1 sprint = 1 week)

**Sprint 1 — Visual rhythm (addresses complaints #1 + #2 + reduces #3 by 30%):**

- A1 (two-tone background) + A2 (section padding) + A3 (section anchors) + B1 (audit) + B2 (lock font:card table) + B3 (document)
- Single coordinated commit + Vercel deploy. Visible win on wadyaljuz overnight.

**Sprint 2 — Card visual interest (completes complaint #3):**

- C1 (OOS ribbon) + C2 (NEW badge) + C3 (compare-at inline) + C4 (hover scale)
- Cards feel alive without changing layout.

**Sprint 3 — Mobile chrome + trust:**

- D1 (bottom tab bar) + D2 (trust strip) + D5 (footer email/phone) + D6 (lang toggle in hamburger)
- Brings FWB to parity with all 3 reference sites on mobile.

**Sprint 4 — PDP polish:**

- D3 (share row) + D4 (spec table)

**Defer for explicit Ahmad GO:** E1 (blog), E2 (brand story), E3 (quick-add), C5 (brand pill).

**Parallel track — Stitch:**

- F1 + F2 in week 1 alongside Sprint 1. F3 between sprints to validate direction before code.

---

## Risks + Open Questions

1. **Two-tone background (A1)** is the biggest visual change. Want to verify with a Stitch preview before rolling out platform-wide. Could be made opt-in per store first, then default.

2. **Bottom tab bar (D1)** changes mobile information architecture — need to make sure it doesn't conflict with PDP sticky add-to-cart bar.

3. **OOS ribbon (C1)** + brand pill (C5) — both overlay the top-left of the product image. Need to pick which wins when both apply, or define non-overlapping positions.

4. **Blog (E1)** is a big-bet — needs Ahmad's "yes I want this" before scoping. Without it, content marketing remains social-only.

5. **Per-tenant editability:** every change above must respect the FWB platform rule — no tenant-specific hardcoding. The two-tone background colors must be tenant-settable; the trust strip content must be tenant-editable; etc.

6. **Friend feedback was unstructured.** Worth doing a 5-minute screen-share with the friend to confirm we're solving the actual complaints, not our interpretation of them.

---

## Decision points for Ahmad

Tag what to do with each:

- **A1 (two-tone background)** — yes / no / "show me in Stitch first"
- **A2 + A3 (section padding + anchors)** — yes / no
- **B (typography ratio audit + table)** — yes / no
- **C1–C4 (card visual interest batch)** — pick which / all
- **C5 (brand pill, opt-in)** — yes / no / defer
- **D1 (bottom tab bar)** — yes / no — biggest mobile change
- **D2 (trust strip)** — yes / no
- **D3 + D4 (PDP share + spec)** — yes / no
- **D5 + D6 (footer + hamburger lang)** — yes / no — quick wins
- **E1 (blog module)** — yes / no / defer
- **E2 (brand story block)** — yes / no / defer
- **E3 (quick-add circle)** — yes / no / defer
- **F (Stitch accelerator workflow)** — yes / no

---

## Files this plan will touch (when implemented)

- `apps/web/src/templates/shared/` — `PecannbeeProductCard.tsx`, `ProductCarousel.tsx`, `HeroBanner.tsx`, `HeroSlider.tsx`, new `TrustStrip.tsx`, new `BlogCarousel.tsx` (E1), new `BrandStoryBlock.tsx` (E2), new `BottomTabBar.tsx` (D1), new `ShareProductRow.tsx` (D3), new `SpecTable.tsx` (D4)
- `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx` — 5 themes (cards visual)
- `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/Footer.tsx` — 5 themes (email/phone)
- `apps/web/src/app/HomePageContent.tsx` — wire new sections
- `apps/web/src/contexts/StoreContext.tsx` — surface bg-color tokens
- `apps/web/src/styles/globals.css` — `--bg-page` / `--bg-section-alt` CSS vars + RTL adjustments
- `apps/admin/src/app/stores/[id]/layout/page.tsx` — admin editor for new sections (trust strip content, brand story content, bg color)
- `apps/api/src/services/store.service.ts` + `packages/database/prisma/schema.prisma` — new fields if needed (`bgPage`, `bgSectionAlt`, `trustStripBlocks`, etc.)
- `apps/web/design.md` — document the new card:font ratio table

Total scope per the FWB platform-fix rule is significant — but most changes are mechanical pattern-applications across the 5 themes once the shared primitive is set.

---

_Plan author: Ahmad + Claude session 2026-05-17. Status: draft for discussion. No code touched yet._
