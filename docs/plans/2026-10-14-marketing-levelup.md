# Marketing level-up (ebda.app) — 2026-10-14

Source review: impeccable critique of the live site, 26/40 (full report kept in the session scratchpad as `marketing-levelup.md`; its findings are summarised here). Main finding: the site still wears the retired night+gold Dahab look and shows only jewellery, so it contradicts the 5-templates × 3-looks product.

## Rulings

- **Ruling MKT-1 — build all P0s as one batch after the looks section lands.** Ahmad, 2026-10-14. Light quiet canvas (gold accent-only, the looks carry the colour); new hero = h1 + one phone cycling the 5 templates + one CTA (NileNight particles and the studio kicker go); order hero → looks → how (4 steps, once) → 3D → payments & shipping → features → pricing → FAQ → close; breakout deleted; **the story scroll stays** and is reskinned with the new Dahab "Worn" look (Ahmad, 2026-10-14, after the P0 call), and the separate 'how' steps band goes instead so the 4 steps appear once; "ابدأ ستور / Ebda Store" names the product in header and hero, the studio story moves to /about + a footer line; WhatsApp contact in header, FAQ, close. Cost if wrong: the night canvas some visitors liked is gone; reversible from git.
- **Ruling MKT-2 — the 3D ring is replaced by "your product page, live".** Ahmad, 2026-10-14. A looks phone shows a product page running the product's real `ProductModelViewer` with an AR button (QR on desktop, Quick Look / Scene Viewer on phones); chips switch vertical. Assets: Khronos `MaterialsVariantsShoe` (CC-BY 4.0, Shopify — credit line required; 3 colourways drive the swatches) for Qamar, Poly Haven `brass_diya_lantern` (CC0) for Souq/Lamma; meshopt not Draco (R-EBDA-3D-3), ≤ ~1.6MB each, lazy behind a poster, still-image fallback for reduced motion / no WebGL. Jasmine + Dahab models are commissioned later (P2). Cost if wrong: CC-BY credit missed = licence breach; the credit goes in CREDITS.md and next to the viewer.
- **Ruling MKT-3 — proof = a live demo store at `storedemo.ebda.app` with a selector bar.** Ahmad, 2026-10-14: "new demo showing all with a selector at top to select template then one of the 3 looks then it renders under storedemo.ebda.app". A real Ebda store (slug `storedemo`, seeded demo catalogue per vertical, labelled demo/illustrative, checkout disabled or test-only) with a demo-only top bar: template → look; the choice re-renders the storefront in that look without persisting (query/cookie preview, never a write). **Depends on the looks being real storefront skins (templates program Phases S + B)**, so the marketing "شوف متجر شغال" link ships when the first template's 3 looks are built, and grows as each template lands. Cost if wrong: a shopper places a real order on a demo store — checkout must be impossible there.

## P0 (one batch, before ads)

1. Light canvas + gold accent-only; contrast re-checked.
2. Hero: h1 + cycling looks-phone (reuses the LooksShowcase phone frame) + one CTA.
3. Section order as in MKT-1; merge story + how.
4. Delete breakout + story scroll (+ their assets, incl. `public/devices/dahab-story-*`).
5. Product name in header/hero; studio story to /about.
6. WhatsApp contact +20 151 419 1411 (Ahmad, 2026-10-14) via `BRAND` (one source), wa.me/201514191411 link plus the number shown as selectable text.
7. Ad readiness: conversion events on signup CTAs + UTM pass-through to signup — reconcile with the existing `feat/ebda-own-ads-tracking` branch (Pixel + CAPI + UTM + PostHog) rather than duplicating it.

## P1

3D Option A (MKT-2) · mobile pricing switcher + collapsed comparison · plain-language plan bullets · 3 hero features with visuals · test Alexandria for display type · one orchestrated hero motion · accessibility pass.

## P2

Per-vertical ad landings (/qamar …) · lantern scroll-turn video for ads/OG · commission Jasmine + Dahab GLBs · merchant story video · CI performance budget (mobile LCP < 2.5s, JS < 200KB before 3D).

## Open

- ~~Looks band: dark moment or light~~ — decided in P0: light (Ruling MKT-4 in `docs/RULINGS.md`).

## P0 as built (2026-10-14, branch `feat/marketing-levelup-p0`)

Items 1-6 plus the phone tab fix; item 7 (ad readiness) is the `feat/ebda-own-ads-tracking` branch (the signup CTAs carry no per-CTA attributes there: PageView + `pricing_viewed` on `#pricing`, and the attribution cookie is read by `store.ebda.app`, so nothing on the CTAs had to be preserved except the `#pricing` id). Section order is `looks, story, dahab, payments, features, pricing, faq, start` after the hero (Ruling MKT-6: Ahmad kept the story scroll, re-skinned with Dahab look A frames, and dropped the separate how band); nav is Templates · How it works (-> story) · Features · Pricing · FAQ. The studio story is `/about` (with the brand line) and a footer credit; the home About section is gone. WhatsApp comes from `BRAND.contact.whatsapp` (`whatsappUrl()`, `whatsappDisplay()`), shown in the header (icon + label, number from 1180px, in the mobile menu below that), the FAQ and the close, always with the number as selectable text.

Contrast of the colour tokens (WCAG 2.x ratios, computed by `tests/unit/marketing-contrast.test.ts` from `globals.css` and `BRAND`):

| Pair                                              | Ratio           | Needs            |
| ------------------------------------------------- | --------------- | ---------------- |
| text `#121314` on canvas `#fafafa`                | 17.8            | 4.5              |
| muted `#575c5d` on canvas / panel / raise         | 6.5 / 6.8 / 6.1 | 4.5              |
| gold-ink `#7b633d` (gold 70%) on canvas           | 5.4             | 4.5              |
| night on brand gold (primary button)              | 6.4             | 4.5              |
| night on lift (button hover)                      | 8.8             | 4.5              |
| line-strong `#868b8c` on canvas (control borders) | 3.3             | 3                |
| raw brand gold on canvas (never used as text)     | 3.0             | fails, by design |
| dark band: text `#f3f5f4` on night                | 18.0            | 4.5              |
| dark band: muted `#a9b1af` on night / panel       | 9.0 / 8.4       | 4.5              |
| dark band: lift `#CBA873` on night / panel        | 8.8 / 8.3       | 4.5              |

## P1 as built (2026-10-14, branch `feat/marketing-levelup-p1`)

3D section (Ruling MKT-7), mobile pricing switcher + collapsed comparison, plain-language plan bullets, product-named titles/OG/JSON-LD and the 3 hero features are in. Section order is now `looks, story, model3d, payments, features, pricing, faq, start`. Not in this batch: Alexandria display-type test, the orchestrated hero motion, per-vertical ad landings, and real-device AR checks.

## Working phones batch (Ahmad, 2026-10-14)

- **Ruling MKT-8 — the looks phones are working mini-stores.** Inside every phone (all 15 looks, marketing site): tapping a product opens its product page in the phone (photos, price, sizes/colours where the look shows them, add to cart); category chips/tiles filter the grid; add to cart updates the cart count; the cart opens as a sheet with lines, quantities and total; "كمّل الطلب" ends on an in-phone demo screen ("ده متجر تجريبي — اعمل متجرك زيه") with the signup button. No network calls, no real order. Driven by one shared engine over data attributes the generator emits, styled by each look's own CSS.
- **Ruling MKT-9 — scrolling and motion.** Native scrolling inside phones (no scroll-jacking), momentum on iOS, `overscroll-behavior: contain` so a phone never drags the page; product page and cart sheet animate with transform/opacity only (≤ 280ms, ease-out), instant under reduced motion; 60fps target on mid-range Android.
- **Ruling MKT-10 — hero phone removed.** The hero is headline + sub + CTAs; the looks section below is where visitors use the phones (Ahmad: it duplicated the looks section and its scrolling was poor).
- **Ruling MKT-11 — WhatsApp is a button only.** Icon + "واتساب" / "WhatsApp" label linking to wa.me; the number is never written on the site (Ahmad, 2026-10-14; supersedes the "number shown as text" line above).
- Leftovers from P1: viewport `colorScheme`/theme colour still night → light; `og.png` still on the retired look → regenerate from a look.
- **Ruling MKT-12 — no credit line under the 3D viewer; the attribution moves to a credits page.** Ahmad, 2026-10-14. The visible "موديل الكوتشي: Shopify، رخصة CC BY 4.0" line under the viewer is gone. CC BY 4.0 still requires attribution "in any reasonable manner", so it lives in `public/demo/CREDITS.md` AND on `/credits` ("حقوق الصور والموديلات" / "Credits"), linked from the footer of every page, generated from `src/lib/credits.ts` (title, author, source, licence link, "modified: optimised for web", triangle count, where it shows). `tests/unit/marketing-model3d.test.ts` now asserts the attribution on that page and in the footer path, and that no credit sits under the viewer; it was moved, not deleted. Cost if wrong: if a reviewer reads a footer link as not "reasonable", the line goes back next to the viewer in one commit.
- **Ruling MKT-13 — Lamma gets its own 3D model.** Ahmad, 2026-10-14 (Souq and Lamma both showed the brass lantern). Poly Haven `ceramic_pot` ("Ceramic Pot", Aron Łyczek, CC0 1.0, https://polyhaven.com/a/ceramic_pot, 3,540 triangles source and shipped): a lidded earthenware cooking pot. Downloaded to the scratchpad `glb-src2/` (nothing executed), optimised with `@gltf-transform/cli@4 optimize --compress meshopt --texture-compress webp --texture-size 1024` to 235 KB (limit 1.6 MB), file `public/3d/lamma-clay-pot.glb`, still `public/3d/stills/clay-pot.{webp,avif}` (read back: it reads as a clay pot), QR unchanged (same URL). Product "حلة فخار بغطاها" / "Lidded clay pot", EGP 380. Cost if wrong: a glazed pot is not what a home-kitchen merchant sells; swapping is one GLB + one copy line.
- **Ruling MKT-14 — section order.** Ahmad, 2026-10-14: hero → story ("متجرك بيتبني قدامك") → looks ("اختار قالب") → 3D → payments → features → pricing → FAQ → start (it reverses the looks-first order of MKT-1/MKT-7). `SECTION_ORDER`, `NAV_ANCHORS` (How it works · Templates · Features · Pricing · FAQ), the tests and `llms.txt` follow. Cost if wrong: the product proof sits one scroll lower than before; reversible by reordering one array.
- **Working-phones build notes (MKT-8, MKT-9).** Engine `src/lib/phone-store.ts` (pure: product, options, cart, filters, view stack, reducer) + `src/lib/phone-store-dom.ts` (event delegation, layers); data attributes emitted by `scripts/looks/lib.py` `pd()`; engine CSS `scripts/looks/phone-store.css`, scoped per template by `export.py`. Overscroll nuance: `overscroll-behavior-y: contain` on the home scroller applies to touch (`pointer: coarse`), where a phone could otherwise drag the page; on a mouse wheel the page continues after the phone's end, because a contained wheel would trap the pointer inside three phones that fill the desktop width. Product page, cart sheet and menu always contain their own scroll.

## MKT-15 as built (2026-10-22, amended same day)

There is no separate `#demo` section: it duplicated the looks section. `#looks` keeps the interactive phones (all five templates) and adds one "open the live store" link per look for Qamar, Souq and Jasmine (`DEMO_STORES` in `site.ts`); `#demo` stays as an anchor inside `#looks`. The unknown-store 404 link is on through the repo variable `SHOW_DEMO_STORE_LINK` (Rulings B1-18, TPL-STOP4-1, TPL-INTERACT-1). `scripts/looks/live-shots.mjs` still captures the live stores on demand; the images are not committed or shipped.

Home AI and value sections: `#ainative` is a numbered list of rows (where the AI works and what it does there); `#capabilities` is a check list of the non-AI value (builder, domain, cart recovery, loyalty, payments and shipping, 0% commission). Neither repeats the other's capabilities.

- **Ruling ASSETS-AI-1 — AI-generated launch assets.** Ahmad, 2026-10-26. Jasmine (serum) and Dahab (solitaire) 3D models are PROCEDURAL three.js glTF (no image-to-3D tool is installed), shipped meshopt at 29 KB and 34 KB and wired as chips 4 and 5 of the 3D section; the lantern scroll-turn ads, poster and five per-vertical OG cards are rendered by `apps/marketing/scripts/3d/render-lantern.mjs` and `apps/marketing/scripts/make-og-verticals.mjs`. Credits list the two models as our own work under CC0 (default taken so the credits page has a licence link). Cost if wrong: if Ahmad prefers another licence, change two entries in `src/lib/credits.ts` and `public/demo/CREDITS.md`.
- **Ruling ASSETS-AI-2 — ship the AI-generated launch assets as they are.** Ahmad, 2026-10-27. Five independent critiques scored the set 6 to 7 of 10 (procedural 3D ceiling); photoreal upgrades were blocked (Gemini image quota 0 on the free tier, no Poly Haven serum or ring model). The 3D chips and OG cards ship wired; the lantern poster and video are wired into the electronics ad page's OG metadata (headline approved by Ahmad 2026-10-27). `scripts/3d/gen-photoreal.py` stays for a later upgrade. Cost if wrong: the beauty and jewellery 3D stills look like decent CG, not product photography; replacing them is one script run once a paid Gemini key exists.
