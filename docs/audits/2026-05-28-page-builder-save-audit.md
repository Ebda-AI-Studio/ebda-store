# Page-Builder Save Audit — 2026-05-28

## Summary

Audited every setting surface in the page-builder (`apps/admin/src/app/stores/[id]/page-builder/page.tsx`)
against its API persistence path. Three gaps found; two fixed in this session.

---

## Save Architecture

The Save button fires three parallel `PUT` calls:

| Call                | Endpoint                              | Persists to                        |
| ------------------- | ------------------------------------- | ---------------------------------- |
| Layout              | `PUT /api/v1/admin/stores/:id/layout` | `Store.layoutSettings` JSON column |
| Typography          | `PUT /api/v1/stores/:id/typography`   | `Store.typography` JSON column     |
| Theme (conditional) | `PUT /api/v1/stores/:id/theme`        | `Store.theme` JSON column          |

Theme call only fires when `pendingThemeUpdates` is non-empty (Smart Palette or
Brand Badge / Quick-Add card-level toggles).

---

## Settings Coverage Matrix

### Layout settings (all surfaces) — `Store.layoutSettings`

| Section               | Fields                                                                                                                                                               | Status      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Hero                  | enabled, mode, autoplayMs, slides, bgColor, typography, dividers                                                                                                     | ✅ persists |
| Categories            | enabled, layout, mobileLayout, captionPosition, cardSize/Aspect/Shape/Gap, showLabel/Hover/CardFrame, cardFrameStyle/Width/Size/Color, bgColor, typography, dividers | ✅ persists |
| New Arrivals          | same card controls as categories + limit                                                                                                                             | ✅ persists |
| Best Sellers          | same as new arrivals                                                                                                                                                 | ✅ persists |
| Filter Sidebar        | enabled, defaultOpen                                                                                                                                                 | ✅ persists |
| Testimonials          | enabled, minRating, verifiedOnly, title, bgColor, typography, dividers                                                                                               | ✅ persists |
| Review Section        | enabled                                                                                                                                                              | ✅ persists |
| Brand Story           | enabled, bgColor, typography, dividers                                                                                                                               | ✅ persists |
| Blog Carousel         | enabled, limit, bgColor, typography, dividers                                                                                                                        | ✅ persists |
| Trust Strip           | enabled, layout, bgColor, typography, dividers                                                                                                                       | ✅ persists |
| Announcement          | enabled, bgColor, typography, dividers                                                                                                                               | ✅ persists |
| Header                | enabled, sticky, bgColor, typography, dividers                                                                                                                       | ✅ persists |
| Footer                | enabled, bgColor, typography, dividers                                                                                                                               | ✅ persists |
| Extra Carousels       | all fields                                                                                                                                                           | ✅ persists |
| Section Order         | sectionOrder array                                                                                                                                                   | ✅ persists |
| Product Card Defaults | cardSize, aspect, shape, gap, frame controls, typography                                                                                                             | ✅ persists |
| Brand Badge toggle    | Staged in `pendingThemeUpdates.showBrandBadge`, flushed to `Store.theme` on Save                                                                                     | ✅ persists |
| Quick-Add toggle      | Staged in `pendingThemeUpdates.showQuickAdd`, flushed to `Store.theme` on Save                                                                                       | ✅ persists |

### Typography zones — `Store.typography`

Global zones (Header card exposes: `beforeHeader`, `header`, `storeName`; Footer card exposes: `footer`, `afterFooter`; Default Typography card exposes all):

| Zone            | API schema covers          | Status                                                            |
| --------------- | -------------------------- | ----------------------------------------------------------------- |
| beforeHeader    | ✅                         | ✅ persists                                                       |
| header          | ✅                         | ✅ persists                                                       |
| **storeName**   | ❌ missing before this fix | **FIXED — added to `typographySchema` in `typography.routes.ts`** |
| categories      | ✅                         | ✅ persists                                                       |
| products        | ✅                         | ✅ persists                                                       |
| footer          | ✅                         | ✅ persists                                                       |
| afterFooter     | ✅                         | ✅ persists                                                       |
| sectionKicker   | ✅                         | ✅ persists                                                       |
| sectionTitle    | ✅                         | ✅ persists                                                       |
| sectionSubtitle | ✅                         | ✅ persists                                                       |
| sectionSeeAll   | ✅                         | ✅ persists                                                       |
| productName     | ✅                         | ✅ persists                                                       |
| productPrice    | ✅                         | ✅ persists                                                       |
| cta             | ✅                         | ✅ persists                                                       |
| filters         | ✅                         | ✅ persists                                                       |

**Gap found and fixed:** `storeName` was absent from the Zod `typographySchema` zones object.
Merchant edits to the Store Name typography zone (inside the Header card on the page-builder)
were silently stripped by Zod validation on every `PUT /stores/:id/typography` call.

---

## Cache Invalidation After Save

| Save           | Cache invalidated                                                       | Status                                                                       |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Layout PUT     | ❌ missing before this fix                                              | **FIXED — calls `invalidateCached('public:store:${storeId}')` after update** |
| Typography PUT | ✅ calls `invalidateCached('public:store:${storeId}')`                  | ✅                                                                           |
| Theme PUT      | ✅ calls `bustStoreCaches(id, slug)` + `StoreService.invalidateCache()` | ✅                                                                           |

**Gap found and fixed:** `PUT /admin/stores/:storeId/layout` did not call any cache invalidation.
The public layout endpoint sets `Cache-Control: public, max-age=60, s-maxage=120` so without
invalidation, storefront visitors could see stale layout for up to 2 minutes after a save.
The fix adds `invalidateCached('public:store:${storeId}')` matching the typography endpoint pattern.

---

## Footer Links (Independent Save)

The `FooterLinksEditor` component embedded in the page-builder has its own Save button and
independent API calls. It does NOT participate in the main Save button. This is intentional —
documented inline in the page-builder component. No gap.

---

## Fonts Card (Page-Level Typography)

Fonts are saved as part of the Typography PUT (the `typographyFonts` state rounds-trips
unchanged when only zones are edited, and gets replaced when the FontsCard onChange fires).
No gap.

---

## Gaps Remaining (Not Fixed)

None found. The two gaps above (storeName zone schema + layout cache invalidation) are the
only issues identified in this audit and both are fixed in PR `fix/page-builder-preview-isolation-collapse-default-save-audit`.
