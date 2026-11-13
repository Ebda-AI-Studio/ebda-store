# Marketing: interactive looks showcase — 2026-10-14

Ahmad, 2026-10-14: the template-directions gallery (https://claude.ai/artifact/Xqg35JTvMtrMddaAufvJkg) is what ebda.app needs: visitors pick a template, see its three looks, scroll and tap inside them. The illustratives on the current site (old Dahab night/gold captures) are replaced. Rulings TPL-1..3 in `docs/plans/done/2026-10-14-templates-and-editor-program.md`.

## Finish line

- **Must work:** a `#looks` section on ebda.app (ar) and ebda.app/en: 5 template tabs (Qamar, Souq, Jasmine, Lamma, Dahab) × 3 looks each; every look is a scrollable phone with working chips/toggles like the gallery; keyboard-operable tabs (arrow keys), each phone labelled "صور توضيحية / Illustrative".
- **Exercised:** `npm run build` (static export) + `check:a11y` + `check:links` + `check:lighthouse`; screenshots at 390 / 820 / 1280 in ar and en; tab switching and in-phone scrolling driven in a browser.
- **Must not change:** pricing, legal pages, signup links, the hero, the 3D ring section, SEO metadata, the `_headers` security headers (no iframe: `X-Frame-Options: DENY` stays).
- **Done when:** the above is green, the old Dahab device captures and story shots are no longer referenced or shipped, Lighthouse performance on mobile does not drop more than 5 points vs main, and Ahmad signs off live.

## Design

- **Source of truth stays the gallery generator** (`scratchpad/directions/build/*.py`, to be moved into `apps/marketing/scripts/looks/`): it gains an export mode writing, per template, `public/looks/<template>.html` (an HTML fragment: 3 phones' markup + scoped CSS, ids `ph-<template>-<a|b|c>`) and the photos as `public/looks/img/<key>.webp` (no base64).
- **`LooksShowcase.tsx`** (client): tablist of 5 templates; the active template's fragment is fetched from `/looks/<template>.html` on first select (Qamar inlined at build for first paint) and injected (our own build artefact, same origin). The fonts a template needs load on select via a Google Fonts `<link>` added once. Desktop: three phones in a row; phone width: one phone with an A/B/C segmented switch plus horizontal snap scroll. Per-look caption: name, who it's for, the bold idea (ar + en strings in `content.ts`).
- **Replaces** the `templates` section (`DevicesShowcase`, `public/devices/dahab-*`) and the story phone's old Dahab shots (`public/devices/dahab-story-*` in `Motion.tsx`) with a look screen. `demo-stores.ts` + `public/demo/CREDITS.md` updated; unused assets deleted.
- **English page:** phones stay Arabic in v1 (Arabic-first product); captions, tabs and labels in English, plus one line saying every template ships in Arabic and English. English phone content is a follow-up.
- **Motion:** tab change cross-fades the trio (opacity/transform, ≤200ms, off under reduced motion).

## Steps

1. Wait for the Dahab looks to land in the gallery (Ruling TPL-2) and Ahmad's review.
2. Move generator into `apps/marketing/scripts/looks/`, add export mode, generate fragments + webp.
3. Build `LooksShowcase.tsx`, wire into `SECTION_ORDER` in place of `templates`, copy in `content.ts` (ar/en).
4. Swap story-phone screens; delete old Dahab device assets; update CREDITS + demo-stores comments + `llms.txt` if it mentions Dahab.
5. Checks above + screenshots; PR.
