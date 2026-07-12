# Design structural batch — plan

Branch `feat/design-structural-batch` off `fix/design-sweep-safe-batch`. Implements the 5 structural
design items from the 2026-07-12 design-taste sweep, under Ahmad's final (v3) contract below.

## Contract (final, v3 — supersedes the two earlier mid-task corrections)

- **Untouchable on every store, every flag state**: card sizes (max-w/h-/aspect/padding on cards),
  product NAME + PRICE typography (size/weight/tracking/family), font families anywhere, any color
  (token or literal). Persona chrome uses existing theme tokens only.
- **Item 1 (duration/easing tokens)**: unconditional, value-preserving. No flag. Every converted
  element keeps its exact current duration/easing value.
- **Items 3 + 5 (skeleton shimmer + stagger, mobile-menu transitions)**: platform defaults for
  _everyone_, including wady-aljuz + Pecannbee — Ahmad explicitly approved motion + loading
  everywhere. No flag. `motion-safe:`/reduced-motion gated; shimmer causes zero layout shift (same
  box, image paints over it).
- **Items 2 + 4 (`personaChromeV2`, `frameChromeDedup`)**: new-stores-only defaults.
  - Existing store rows: flag undefined → OFF, rendered exactly as today (wady-aljuz + Pecannbee
    included — zero visual change).
  - New stores: seeded `true` for both flags at store-creation time (`StoreService.create`).
  - Demo clones (`clone-demo-stores.ts`): seeded `true` for both — showcases the new personas.
  - Admin toggles let any existing store opt in manually (Branding → Theme, `storefrontWebPushEnabled`
    pattern).
  - Implemented as `StoreTheme` boolean flags (not `StoreLayoutSettings`) — single JSON column,
    single admin surface (ThemeTab already manages `theme`, not `layoutSettings`); avoids splitting
    two related toggles across two data models/pages. Deviation from the literal "layout flag"
    wording in item 4's brief, noted here.

## Item 1 — duration/easing token scale

- `apps/web/src/styles/globals.css` `:root`: add `--duration-fast: 200ms`, `--duration-base: 300ms`,
  `--duration-slow: 500ms`, `--duration-slower: 700ms`, `--ease-out: cubic-bezier(0, 0, 0.2, 1)`,
  `--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1)` (exact values Tailwind's `ease-out`/`ease-in-out`
  utilities already resolve to — verified against `tailwind.config`, so swapping the keyword for the
  var changes nothing computed).
- Scope: `apps/web/src/templates/shared/pack-styles.ts` (the single per-theme "declares timing once"
  file — every theme's card/CTA/hero/heading hover motion lives here) + the shared cross-theme
  components that consume duration literals directly: `ProductCarousel.tsx`, `CategoryStrip.tsx`,
  `PecannbeeProductCard.tsx`, `card-size.ts`, `HeroSlider.tsx`, `BlogCarousel.tsx`,
  `BottomTabBar.tsx`, `FloatingWidget.tsx`.
- Convert `duration-200/300/500/700` → `duration-[var(--duration-fast/base/slow/slower)]` and
  `ease-out`/`ease-in-out` → `ease-[var(--ease-out/in-out)]`, 1:1 literal-for-literal (arbitrary-value
  Tailwind classes referencing the CSS var — JIT keeps them because the full class string is static
  text in source, not runtime-concatenated).
- **Explicit scope-narrowing** (stated as a deviation, not silent): the 5 per-theme
  `Header.tsx`/`Footer.tsx`/`ProductCard.tsx`/`CategoryCard.tsx`/`Hero.tsx`/`OrderSummary.tsx`/
  `CartTable.tsx`/`AnnouncementBar.tsx` files (40 files, ~200 more literal occurrences) each carry
  their OWN separate hardcoded duration/ease classes outside the shared pack-styles/shared-component
  surface. Converting all of them is out of scope for this PR (disproportionate risk for a pure
  token-naming refactor within an already-large 5-item batch) — flagged as a follow-up. Zero risk:
  untouched code cannot regress.
- Verify: PR body carries a grep-generated before/after table (file → old literal → new token class
  → same computed value).

## Item 2 — `personaChromeV2` (StoreTheme flag, seeded true on new stores only)

Chrome-only completions using existing theme tokens, gated `store.theme?.personaChromeV2 === true`:

- **Elegant** — `SectionHeading.tsx`: when `pack === 'elegant'` and the flag is on, default the
  title-hairline flanking on (mirrors the existing kicker/subtitle default-on hairlines) unless the
  merchant explicitly set `dividers.title.enabled`. Whisper CTA: `sectionSeeAll` link gets a
  `border-t border-foreground/15 pt-1` top hairline (matching the productCardCta whisper idiom
  already in elegant's pack-styles) when the flag is on.
- **Classic** — `CategoryGrid.tsx`: when the flag is on and the merchant hasn't picked an explicit
  `cardShape`, resolve the shape via the existing `cardShapeClasses('circle')` helper instead of the
  template default (rectangular). No new shape vocabulary — reuses the shape already in
  `card-size.ts`.
- **Bold** — `Header.tsx`: `border-2 border-b-2 border-foreground` frame when the flag is on (bold's
  existing 2px-border brutalist idiom, extended to the header). `Footer.tsx`: inverted
  `bg-foreground text-background` footer when the flag is on (bold's own inverted-footer design.md
  spec, currently unimplemented in code).

## Item 3 — skeleton shimmer + stagger (unconditional, motion-safe)

- Shimmer: append the existing `.shimmer` utility class to the image-wrapper div (the one that
  already carries `bg-muted`) in: `PecannbeeProductCard`, `ProductCarousel`, `CategoryStrip`,
  `HeroBanner`, and all 5 themes' `ProductCard.tsx` + `CategoryCard.tsx`. The `<Image fill>` paints
  over the shimmer once loaded — same box, zero layout shift, no JS state needed. Reduced-motion
  already globally zeroes `.shimmer`'s animation-duration (existing rule in globals.css).
- Stagger: reuse the exact recipe already live on `modern/ProductGrid.tsx`
  (`motion-safe:[animation:fadeUp_0.5s_ease-out_calc(var(--i)*Nms)_both] motion-reduce:opacity-100`
  - `style={{'--i': index}}`) — modern's existing 60ms step is untouched (pre-existing behavior, not
    reset). Add the same pattern at the item-3-specified 40ms step to the 4 themes lacking it
    (`classic/minimal/bold/elegant` `ProductGrid.tsx`), the 5 `CategoryGrid.tsx`, and the `<li>` items
    of `ProductCarousel.tsx` + `CategoryStrip.tsx` (no new wrapper element needed there — the `<li>`
    already exists per item).

## Item 4 — `frameChromeDedup` (StoreTheme flag, seeded true on new stores only)

`ProductCarousel.tsx` + `CategoryStrip.tsx` only (per Ahmad's scoping). When
`layout` — actually `store.theme?.frameChromeDedup === true` AND the section's `showCardFrame` is
active, suppress the inner pack-style chrome (`styles.card` / `styles.categoryFrame`) so only the
outer `cardFrameClass` frame renders — removes the doubled-frame look. Default (flag off/undefined):
today's rendering, both frames, unchanged.

## Item 5 — mobile menu enter/exit transitions (unconditional, motion-safe)

220ms `ease-out` in / 160ms `ease-out` out, same axis both ways (plain Tailwind arbitrary-duration
classes — 220/160 aren't part of the 4-step `--duration-*` scale from item 1, so they're defined
inline per Ahmad's explicit spec, not mapped onto that scale). Two implementations depending on each
theme's existing structure:

- **`classic`/`minimal`/`elegant`**: their mobile menus were conditionally MOUNTED
  (`{isMenuOpen && (...)}`) — no exit transition was possible. Converted to always-rendered with a
  `grid-template-rows` 0fr↔1fr collapse (the standard height-animation idiom for variable-height
  content), so the exit animation can play before the content is visually hidden.
- **`modern`/`bold`**: already fixed-position drawers sliding via `translate-x` — kept that
  mechanism, just unified the duration to the shared 220ms-in/160ms-out curve (was a flat
  300ms/200ms both directions).
- Both use `motion-reduce:duration-0` (not `motion-safe:` prefixing every class) so the open/close
  state change is instant, not skipped, for reduced-motion users.

## Admin + docs

- `packages/shared/src/types/store-theme.ts`: add `personaChromeV2?: boolean` and
  `frameChromeDedup?: boolean` with doc comments (default false/undefined; seeded true on new stores).
- `apps/admin/.../branding/_components/types.ts`: mirror both fields on the local `StoreTheme` type.
- `apps/admin/.../branding/_components/ThemeTab.tsx`: two new compact toggle sections, same inline
  bilingual-label pattern as `storefrontWebPushEnabled` (ThemeTab already has 8+ toggle sections —
  ceiling rule already exceeded in practice; adding 2 more inline is consistent with existing
  precedent rather than spinning up a new page).
- `apps/api/src/services/store.service.ts` `StoreService.create()`: seed
  `theme: { personaChromeV2: true, frameChromeDedup: true }` on the Prisma create call.
- `packages/database/prisma/clone-demo-stores.ts`: override the spread-from-source `theme` with
  `{ ...sourceTheme, personaChromeV2: true, frameChromeDedup: true }` for the 4 cloned demo stores.
- `docs/architecture/store-theme-flags.md`: add both flags to the flags table, documenting the
  seeded-at-creation behavior explicitly.

## Verify

- `npm run lint` + `tsc` on `apps/web` + `apps/admin`, `npm run test:unit`.
- Grep-prove zero changes to font-family/text-size classes on product name/price elements (diff the
  touched card files, confirm `productCardName`/`productCardPrice`/`data-zone="productName"` /
  `data-zone="productPrice"` class strings are byte-identical before/after).
- `packages/database/scripts/verify-baseline-nodrift.mjs` only if `DATABASE_URL` available, else
  state skipped.
- Blast-radius: grep `personaChromeV2|frameChromeDedup` across code + admin + docs +
  clone-demo-stores + store.service to confirm every consumer is covered.
