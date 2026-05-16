# FWB Design — sizing rules (ahmad standing preference)

Ahmad's standing rule, codified 2026-05-16 after multiple rounds of
"things are still too big": **default to compact ecommerce sizing on
both desktop and mobile.** No oversized cards, hero-tier imagery, or
marketing-page chrome inside transactional surfaces.

When in doubt, lean SMALLER. Reference for sane defaults is the
pecannbee + alkahraman + similar Kuwait/GCC stores.

## Industry benchmark sizes (apply these)

| Element                        | Mobile (W)                            | Desktop (W)            | Notes                                                                                                                             |
| ------------------------------ | ------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Product card                   | 150-180px                             | 180-220px              | Cap with `max-w-[200px] md:max-w-[200px]`. Theme ProductCards inherit same cap so PDP "related products" matches main grid sizing |
| Category card                  | 150-170px                             | 170-200px              | Cap with `max-w-[170px] md:max-w-[190px]`. Grid gap stays at gap-3 md:gap-4 (never gap-4+ on mobile or gap-6+ on desktop)         |
| Carousel item (homepage strip) | 140-180px                             | 180-220px              | `w-[44vw] sm:w-[28vw] md:w-[22vw]` baseline                                                                                       |
| Logo header                    | 48-56px (h-12 to h-14)                | 64-80px (h-16 to h-20) | Mobile MUST stay ≤56px to leave room for centered alignment between hamburger + actions                                           |
| Hero image                     | aspect-[3/2] mobile / [2.4/1] desktop | —                      | Already standardized in `HeroBanner.tsx`                                                                                          |
| Internal card padding          | p-3 mobile / p-4 desktop              | —                      | Never p-5+ on cards                                                                                                               |
| Card content gap               | gap-2                                 | —                      | Never gap-3+ between name/price/cta                                                                                               |

## Anti-patterns to refuse

1. **Don't use `aspect-square` for product card images on mobile if it makes the card taller than 250px combined with content below.** Switch to `aspect-[4/3]` (landscape) or accept smaller cards via column count.
2. **Don't add `min-h-[Xem]` to product name lines** — let cards size to their content. Reserved height blocks waste vertical space in dense grids.
3. **Don't go above h-20 (80px) for mobile logos** — the centered layout (absolute-positioned) breaks at h-24 because wide wordmarks overflow into the hamburger/actions row.
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
