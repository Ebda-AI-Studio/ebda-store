# FWB Design — sizing rules (ahmad standing preference)

Ahmad's standing rule, codified 2026-05-16 after multiple rounds of
"things are still too big": **default to compact ecommerce sizing on
both desktop and mobile.** No oversized cards, hero-tier imagery, or
marketing-page chrome inside transactional surfaces.

When in doubt, lean SMALLER. Reference for sane defaults is the
pecannbee + alkahraman + similar Kuwait/GCC stores.

## Industry benchmark sizes (apply these)

| Element                        | Mobile (W)                            | Desktop (W)  | Notes                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product card                   | 150-180px                             | 180-220px    | Cap with `max-w-[200px] md:max-w-[200px]`. Theme ProductCards inherit same cap so PDP "related products" matches main grid sizing                                                                                                                                                 |
| Category card                  | 170-200px                             | 240-280px    | Cap with `max-w-[200px] md:max-w-[280px]`. Mobile bumped DOWN per Ahmad 2026-05-16 'on mobile make categories a little bit smaller' while desktop stays at the hero-section size. Grid gap stays at gap-3 md:gap-4                                                                |
| Carousel item (homepage strip) | 140-180px                             | 180-220px    | `w-[44vw] sm:w-[28vw] md:w-[22vw]` baseline                                                                                                                                                                                                                                       |
| Logo header                    | 96px (h-24)                           | 112px (h-28) | Mobile capped by `max-w-[65%]` on the centered Link + Account icon hidden on mobile (md:inline-flex) so the freed row width gives the bigger logo room. Row height bumped to h-28 mobile / md:h-32 to accommodate. Ahmad 2026-05-16 'want it more bigger both mobile and desktop' |
| Hero image                     | aspect-[3/2] mobile / [2.4/1] desktop | —            | Already standardized in `HeroBanner.tsx`                                                                                                                                                                                                                                          |
| Internal card padding          | p-3 mobile / p-4 desktop              | —            | Never p-5+ on cards                                                                                                                                                                                                                                                               |
| Card content gap               | gap-2                                 | —            | Never gap-3+ between name/price/cta                                                                                                                                                                                                                                               |

## Typography sizes (apply these across all 5 themes)

Standing rule updated 2026-05-16 (second pass) per Ahmad's Wady Aljuz baseline:
**every text zone defaults to 16px (text-base) at the theme level.** Headings,
body, kickers, subtitles, seeAll links, CTAs — all 16px platform defaults.
Theme identity carries via font-weight + tracking + font-family ONLY
(modern=semibold-sans, elegant=hairline-tracking-wide, bold=font-black-
uppercase, classic=serif-normal, minimal=light-tracking-wide), NEVER via
size differentiation. Hero headline remains the only intentional scale
exception (36-72px responsive) because hero is the brand statement.

Merchants can override any zone via Typography admin (per-store).
Earlier responsive heading scales (text-3xl → text-5xl, etc.) were
reverted to text-base on 2026-05-16 after Ahmad's "make those the main
sizes of everything" directive — flat hierarchy by default; merchant
opts up via admin if their brand needs heading prominence.

| Element (pack-styles token)                        | Mobile  | sm (640+)  | md (768+) | lg (1024+) | Tailwind                                                       | Notes                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ------- | ---------- | --------- | ---------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section title** (`sectionHeading`)               | 30px    | 36px       | —         | 48px       | `text-3xl sm:text-4xl lg:text-5xl`                             | Modern keeps `lg:text-[2.75rem]` (44px) — its only allowed deviation. Bold: same as others; brutalist scale lives on hero, not section titles                                                                                                                                                         |
| **Section kicker chip**                            | 11-13px | —          | —         | —          | `text-[11px]` / `text-xs`                                      | Small uppercase tracking-wide. Coloured chip overrides via Typography admin chip presets                                                                                                                                                                                                              |
| **Section subtitle** (tagline)                     | 14px    | 16px       | —         | —          | `text-sm sm:text-base`                                         | Sits under section title; muted color is fine; size is for readability                                                                                                                                                                                                                                |
| **Section "see all" link**                         | 14px    | —          | —         | —          | `text-sm`                                                      | Standardize from previous text-xs / text-[11px] / text-sm mishmash → text-sm everywhere. Identity carries via weight/uppercase/tracking, not below 14px                                                                                                                                               |
| **Product card name** (`productCardName`)          | 16px    | 18px (md+) | —         | —          | `getProductCardTextSizes(cardSize).name`                       | MAIN reading text. 16px floor — never below. Scales UP per `cardSize`: xs/sm = text-base, md = text-base sm:text-lg (default), lg = text-lg, xl = text-lg sm:text-xl. Pack-styles drives flavor (weight/tracking/color/family) only — size tokens stripped from pack-styles as of 2026-05-17 Sprint 1 |
| **Product card price** (`productCardPrice`)        | 16px    | 18px (md+) | —         | —          | `getProductCardTextSizes(cardSize).price`                      | MAIN reading text. 16px floor. Scales UP per `cardSize` mirror of name table. Variant compare-at strikethrough stays at `text-sm` per existing pattern                                                                                                                                                |
| **Category caption** (`categoryCaption`)           | 16px    | 18px       | —         | —          | `text-base sm:text-lg` (modern/classic) / `text-base` (others) | MAIN reading text. Modern + classic can step up to 18 on desktop                                                                                                                                                                                                                                      |
| **Product CTA / button** (`productCardCta`, `cta`) | 14px    | —          | —         | —          | `text-sm`                                                      | Standardize from text-xs / text-[11px] / text-sm mishmash. 44px min-height already locked. Identity carries via weight + uppercase + tracking                                                                                                                                                         |
| **Hero headline** (`heroHeadline`)                 | 36px    | 48px       | 60px      | 72px       | `text-4xl sm:text-5xl md:text-6xl lg:text-7xl`                 | Bold can step to 48 / 60 / 72 / 96 (text-5xl sm:text-6xl md:text-7xl lg:text-8xl) — brutalist exception                                                                                                                                                                                               |
| **Hero CTA**                                       | 14-16px | —          | —         | —          | `text-sm` or `text-base`                                       | text-sm minimum                                                                                                                                                                                                                                                                                       |
| **Header nav links**                               | 14px    | 16px       | —         | —          | `text-sm sm:text-base`                                         | iOS safari no-zoom requires 16px on focusable inputs; nav links aren't inputs but match the floor for consistency                                                                                                                                                                                     |
| **Footer fine print**                              | 12-14px | —          | —         | —          | `text-xs sm:text-sm`                                           | Copyright row, social icons labels — small print is OK here                                                                                                                                                                                                                                           |
| **Announcement bar** (`beforeHeader`)              | 12-13px | 14px       | —         | —          | `text-xs sm:text-sm`                                           | Promo banner, secondary to main content                                                                                                                                                                                                                                                               |
| **Form input (mobile)**                            | 16px    | —          | —         | —          | `text-base sm:text-sm`                                         | iOS Safari force-zooms when an `<input>` under 16px gets focus. Standing rule, ESLint-enforced — see global memory `feedback-mobile-form-text-base`                                                                                                                                                   |

**Per-theme identity** stays via weight + tracking + family at these standardized sizes:

| Theme   | Identity carriers                                                                  |
| ------- | ---------------------------------------------------------------------------------- |
| modern  | sans-serif semibold/bold + tight tracking + rounded-2xl frames                     |
| classic | font-serif normal + sharp corners + uppercase tracking-[0.22em] on chrome controls |
| minimal | font-light + tracking-[0.18-0.28em] + uppercase + muted-foreground until hover     |
| bold    | font-black uppercase + tracking-tight + brutalist 2px borders                      |
| elegant | font-extralight/light + tracking-[0.22-0.32em] + hairline borders + 700ms hovers   |

**Anti-pattern**: shrinking a font BELOW the table to recreate "this theme uses tiny text" feel. The themes diverge on weight + tracking, NEVER on main-text size. The pre-2026-05-16 state where minimal used text-xs (12px) for product name was a legibility regression hidden as "design choice".

## Anti-patterns to refuse

1. **Don't use `aspect-square` for product card images on mobile if it makes the card taller than 250px combined with content below.** Switch to `aspect-[4/3]` (landscape) or accept smaller cards via column count.
2. **Don't add `min-h-[Xem]` to product name lines** — let cards size to their content. Reserved height blocks waste vertical space in dense grids.
3. **Don't go above h-16 (64px) for mobile logos** without the `max-w-[50%]` guard on the centered Link wrapper. The guard clamps logo width to half the viewport so even h-16 stays safe between hamburger + actions on a 320px screen. h-18+ tends to bleed into the actions row regardless.
4. **Don't use gap-4 / gap-6 in product GRIDS at mobile** — gap-3 is the floor; gap-4 only at md+ where viewport allows.
5. **Don't use `p-5 sm:p-6` for any card body** — that's marketing-page padding, not transactional. Cards: `p-3 sm:p-4` max.
6. **Don't cap category cards above 180px desktop** — pecannbee/alkahraman top out at ~150-160px. Bigger reads as "feature tile", not "category nav".

## When Ahmad says "still too big"

Pattern recognition: this happens when an element grew during dev to fit
some content (long Arabic name, full address, larger image). Default
fix path:

1. **Shrink the container first** (max-w), not the content. Content can
   wrap / line-clamp; container should be predictable.
2. **Reduce padding**, then gap, then text size — in that order.
3. **Add more grid columns** before changing aspect ratios. More
   columns = naturally smaller cards.
4. **Cap with `max-w-[Xpx] mx-auto`** when grid spans wider than the
   element should ever get (sparse grids with 3-4 items).

## RTL preserves these sizes

All sizes apply identically for RTL (Arabic) and LTR (English). Arabic
text DOES occupy slightly more horizontal width per character on
average, so be generous with `min-w-[Nrem]` on select / dropdown
controls (see `feedback-fwb-select-wrapper-stack-toolbars` global
memory). But card / image dimensions stay constant.

## Update process

When sizes change here:

1. Update the relevant tailwind classes in `apps/web/src/templates/**`
2. Commit with `fix(web): design.md tighten <surface> per ecommerce benchmark`
3. Sync the change to the affected memory file under
   `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-
website-builder/memory/` so future sessions read the rationale.

This file is the single source of truth for sizing across the platform.
Future Claude sessions should read it FIRST before touching any
size-related class.
