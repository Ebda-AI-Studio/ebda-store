# Marketing level-up (ebda.app) — 2026-10-14

Source review: impeccable critique of the live site, 26/40 (full report kept in the session scratchpad as `marketing-levelup.md`; its findings are summarised here). Main finding: the site still wears the retired night+gold Dahab look and shows only jewellery, so it contradicts the 5-templates × 3-looks product.

## Rulings

- **Ruling MKT-1 — build all P0s as one batch after the looks section lands.** Ahmad, 2026-10-14. Light quiet canvas (gold accent-only, the looks carry the colour); new hero = h1 + one phone cycling the 5 templates + one CTA (NileNight particles and the studio kicker go); order hero → looks → how (4 steps, once) → 3D → payments & shipping → features → pricing → FAQ → close; story scroll + breakout deleted (37% of page height, steps shown twice); "ابدأ ستور / Ebda Store" names the product in header and hero, the studio story moves to /about + a footer line; WhatsApp contact in header, FAQ, close. Cost if wrong: the night canvas some visitors liked is gone; reversible from git.
- **Ruling MKT-2 — the 3D ring is replaced by "your product page, live".** Ahmad, 2026-10-14. A looks phone shows a product page running the product's real `ProductModelViewer` with an AR button (QR on desktop, Quick Look / Scene Viewer on phones); chips switch vertical. Assets: Khronos `MaterialsVariantsShoe` (CC-BY 4.0, Shopify — credit line required; 3 colourways drive the swatches) for Qamar, Poly Haven `brass_diya_lantern` (CC0) for Souq/Lamma; meshopt not Draco (R-EBDA-3D-3), ≤ ~1.6MB each, lazy behind a poster, still-image fallback for reduced motion / no WebGL. Jasmine + Dahab models are commissioned later (P2). Cost if wrong: CC-BY credit missed = licence breach; the credit goes in CREDITS.md and next to the viewer.
- **Ruling MKT-3 — proof = a live demo store at `storedemo.ebda.app` with a selector bar.** Ahmad, 2026-10-14: "new demo showing all with a selector at top to select template then one of the 3 looks then it renders under storedemo.ebda.app". A real Ebda store (slug `storedemo`, seeded demo catalogue per vertical, labelled demo/illustrative, checkout disabled or test-only) with a demo-only top bar: template → look; the choice re-renders the storefront in that look without persisting (query/cookie preview, never a write). **Depends on the looks being real storefront skins (templates program Phases S + B)**, so the marketing "شوف متجر شغال" link ships when the first template's 3 looks are built, and grows as each template lands. Cost if wrong: a shopper places a real order on a demo store — checkout must be impossible there.

## P0 (one batch, before ads)

1. Light canvas + gold accent-only; contrast re-checked.
2. Hero: h1 + cycling looks-phone (reuses the LooksShowcase phone frame) + one CTA.
3. Section order as in MKT-1; merge story + how.
4. Delete breakout + story scroll (+ their assets, incl. `public/devices/dahab-story-*`).
5. Product name in header/hero; studio story to /about.
6. WhatsApp contact +20 120 776 1882 (Ahmad, 2026-10-14) via `BRAND` (one source), wa.me/201207761882 link plus the number shown as selectable text.
7. Ad readiness: conversion events on signup CTAs + UTM pass-through to signup — reconcile with the existing `feat/ebda-own-ads-tracking` branch (Pixel + CAPI + UTM + PostHog) rather than duplicating it.

## P1

3D Option A (MKT-2) · mobile pricing switcher + collapsed comparison · plain-language plan bullets · 3 hero features with visuals · test Alexandria for display type · one orchestrated hero motion · accessibility pass.

## P2

Per-vertical ad landings (/qamar …) · lantern scroll-turn video for ads/OG · commission Jasmine + Dahab GLBs · merchant story video · CI performance budget (mobile LCP < 2.5s, JS < 200KB before 3D).

## Open

- Looks band: stays the one dark moment or goes light with the page — decide during P0 build with screenshots of both.
