# Ebda storefront template shortlist (Phase 0)

Date: 2026-10-07. Companion to `2026-10-07-ebda-visual-builder-roadmap.md` (template brief) and the gap matrix (#18). Five **original Ebda preset families** for Egyptian merchants, each defined as a `PageDefinition` preset + theme tokens + registry defaults (roadmap: presets use the same schema as layouts). References are for composition ideas only.

## Licensing posture (binding)

- **Next.js Commerce (vercel/commerce):** MIT per the roadmap's verified license link. The only code candidate: selected UI patterns may be adapted (bento product grid, search bar, collection filter, product card) into Ebda's renderer with the notice preserved. Not verified in this pass: which commit the reference deployment tracks and its asset licenses (product photos are demo assets — never reuse).
- **Shopify Horizon family (Horizon, Fabric, Atelier, Savor, Ritual):** _visual reference only._ Horizon source is restricted to Shopify interoperability (roadmap). Nothing is copied: no markup, CSS, copy, or images. Screenshots below are internal reference captures of public demo storefronts taken 2026-10-07; their imagery belongs to the demo's owners and the files should be dropped before any public docs site is built from this repo.
- **Plasmic / Webstudio:** AGPL core — concepts only, not used here.
- No paid service or subscription is needed for any item below.

## Reference captures (7 of the ~8 budget)

Saved in `docs/plans/assets/builder-phase0/` (1440×900 viewport unless noted).

| File                                      | Source                             | What it shows                                                                                        |
| ----------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `01-nextjs-commerce-desktop.png`          | `next-commerce-v2.vercel.app`      | Search-first header, bento hero (1 large + 2 stacked product tiles with price pills).                |
| `02-nextjs-commerce-mobile.png` (390×844) | same                               | Same layout collapsed to a single column on a phone.                                                 |
| `03-horizon-default.png`                  | `theme-horizon-demo.myshopify.com` | Full-bleed hero with centred headline + ghost CTA; "Featured products" 4-up grid with "View all".    |
| `04-fabric.png`                           | `theme-fabric-demo.myshopify.com`  | Full-viewport motion hero, oversized wordmark, transparent overlay nav.                              |
| `05-atelier.png`                          | `theme-atelier-demo.myshopify.com` | Cinematic photo hero with large light serif headline; centred wordmark, uppercase nav.               |
| `06-savor.png`                            | `savor-theme-demo.myshopify.com`   | Saturated colour hero with product cluster, condensed display type; edge-to-edge 3-up product tiles. |
| `07-ritual.png`                           | `theme-ritual-demo.myshopify.com`  | Flat colour block hero with giant wordmark and tiny intro; 6-up row of cut-out product images.       |

Notes from the capture pass: `demo.vercel.store` (the roadmap's demo link) returned **404 on 2026-10-07**; `next-commerce-v2.vercel.app` was used instead and is a different deployment, so treat it as visual reference, not as the reviewed upstream demo. Atelier's capture shows a third-party chat widget overlay. None of these were checked in Arabic/RTL — the references are LTR English; RTL behaviour is Ebda's own work and must be proven per family (rubric below). Screenshots of 360px / tablet / PDP / cart / checkout views required by the roadmap rubric are **not** yet taken (budget); the first Phase 2 task is to capture Ebda's current 5 templates against the same rubric so the "what is wrong today" list is evidence, not assumption (Ahmad's complaint is recorded, the defects are not yet itemised).

## The five families

Final names (Ahmad, 2026-10-07) replace the Phase 0 working names: Souq سوق (unchanged), Dahab دهب (was Dhahab ذهب), Qamar قمر (was Nour نور), Lamma لمّة (was Matbakh مطبخ), Jasmine ياسمين (was Glow توهج). Template ids and labels in code: `TEMPLATE_FAMILIES` in `packages/shared/src/builder/template-families.ts`.

Each family: name (final, Ahmad 2026-10-07; template id in brackets), merchant vertical, reference pattern, why it fits, required sections (registry types; **new** = not in the current catalogue).

### 1. Souq (سوق) [`souq`] — everyday catalogue, electronics, general retail

- **Reference:** Next.js Commerce bento hero + search-first header (captures 01, 02); Horizon's plain "Featured products / View all" rhythm (03).
- **Why it fits:** Egyptian shoppers compare on price and availability; search + category chips + visible COD/delivery reassurance beat editorial mood. Dense grid with clear EGP price, installment/COD badge slot. Electronics need spec-friendly cards and warranty trust items.
- **Sections:** `announcement` (free-shipping threshold in EGP) · `header` (search-first, cart, WhatsApp) · `hero` as 3-tile bento of featured products · `category-grid` chips · `product-grid` (filters, 2-col mobile / 4-col desktop) · `trust-strip` (COD, 14-day return, warranty) · `testimonials` · `newsletter` **new** · `footer`.

### 2. Qamar (قمر) [`qamar`] — fashion and boutique

- **Reference:** Horizon full-bleed hero + featured grid (03), Fabric's confident oversized type and overlay nav (04), Ritual's colour-block + cut-out product row for streetwear (07).
- **Why it fits:** Fashion sells on imagery and collections; size/colour variants must be obvious on mobile where most Egyptian traffic arrives. Collection-led navigation (Women/Men/New) maps to the registry's collection binding.
- **Sections:** `header` (transparent over hero) · `hero` full-bleed or colour-block variant · `collection-list` (Phase 4) or `category-grid` · `product-grid` 4-up with variant swatches on card · `image-text` **new** (lookbook/editorial) · `brand-story` · `testimonials` · `footer`.

### 3. Dahab (دهب) [`dahab`] — jewellery, handmade, premium gifts (brand-aligned)

- **Reference:** Atelier's serif statement hero and restrained uppercase nav (05); gold-on-night matches Ebda's own `BRAND` (night `#0A0B0C`, gold `#B08D57`/`#CBA873`).
- **Why it fits:** Low-volume, high-ticket items need story and craft, not density. Arabic display serif/Naskh pairing is a differentiator against generic Shopify-looking stores; dark surfaces make gold and gemstones read well. Also doubles as Ebda's own showcase look.
- **Sections:** `header` centred logo · `hero` statement (headline + single CTA, dark overlay) · `product-grid` 3-up large cards · `image-text` **new** (craftsmanship) · `brand-story` · `testimonials` · `newsletter` **new** · `footer`. Needs an Arabic-capable display face decision (token, see file plan cross-cutting).

### 4. Lamma (لمّة) [`lamma`] — food, home kitchen, sweets and gifts

- **Reference:** Savor's saturated colour hero + edge-to-edge 3-up product tiles (06).
- **Why it fits:** Home-kitchen sellers (Instagram/WhatsApp-led) want appetite appeal, 3 large tiles that read on a phone, and clear delivery area/time info. Bold single-colour brand blocks are cheap for a merchant to supply (no studio photography needed).
- **Sections:** `announcement` (delivery areas/cut-off) · `header` · `hero` colour-block with product cluster · `product-grid` 3-up tiles · `category-grid` (occasions: Eid, boxes) · `trust-strip` (freshness, delivery window — copy only; **no scheduling feature promised**, per roadmap) · `blog-carousel` (recipes) · `footer`.

### 5. Jasmine (ياسمين) [`jasmine`] — beauty and skincare

- **Reference:** Ritual's flat colour block with giant wordmark and a cut-out product row (07), softened; Horizon's quiet spacing (03).
- **Why it fits:** Beauty products photograph on plain backgrounds (cut-outs) and sell on benefits, ingredients and genuine reviews; returns/hygiene policy needs to be visible. Pastel colour-block hero is merchant-configurable from one token.
- **Sections:** `hero` colour-block · `product-grid` carousel/6-up cut-outs · `trust-strip` (authenticity, delivery/returns) · `image-text` **new** (ingredients/routine) · `testimonials` (verified purchase only — existing endpoint filter `verifiedOnly`) · FAQ (CMS page, Phase 4) · `newsletter` **new** · `footer`.

### Considered and parked

- **Fabric-style video hero as its own family:** heavy media (bandwidth on Egyptian mobile networks) and autoplay accessibility cost; offer later as a `hero` variant, not a family.
- **Plasmic Marketplace templates:** not evaluated (roadmap: listing page content unretrievable; asset rights unclear).

## Summary matrix

| Family  | Vertical              | Primary hero               | Grid            | New sections needed         | Reference captures |
| ------- | --------------------- | -------------------------- | --------------- | --------------------------- | ------------------ |
| Souq    | General / electronics | Bento featured products    | 4-up, filters   | `newsletter`                | 01, 02, 03         |
| Qamar   | Fashion / boutique    | Full-bleed or colour block | 4-up            | `image-text`                | 03, 04, 07         |
| Dahab   | Jewellery / handmade  | Dark statement + serif     | 3-up large      | `image-text`, `newsletter`  | 05                 |
| Lamma   | Food / home kitchen   | Saturated colour block     | 3-up tiles      | none (uses `blog-carousel`) | 06                 |
| Jasmine | Beauty                | Pastel colour block        | 6-up / carousel | `image-text`, `newsletter`  | 07, 03             |

New sections needed overall: `image-text` and `newsletter` only (everything else maps to existing renderers) — consistent with the file plan's Phase 1 catalogue.

## Evaluation to run before building any family (roadmap rubric, unchanged)

For each family at **360px, 820px, 1280px, in Arabic RTL and English**: homepage, collection, product, search, cart. Score: product clarity, navigation, typography/spacing, image cropping, CTA visibility, Arabic/RTL, keyboard/focus, contrast (WCAG AA on gold-on-night), empty/error states, merchant editability. Prove with the merchant's own products: long Arabic names, EGP formatting (Arabic-Indic vs Latin digits decision), missing images fall back, collection references belong to the store. Merchant validation (2–3 Egyptian sellers per vertical) is **not done**; the vertical → family mapping above is a hypothesis from the research brief, not evidence.

## Open questions for Ahmad

1. ~~Reinstate desktop + tablet preview?~~ Decided: yes (BUILDER-PREVIEW-1, Ahmad 2026-10-07; docs/RULINGS.md).
2. Geist for Latin on storefront presets, or keep Plus Jakarta Sans? Arabic display face for Dahab?
3. Is "Dahab" (dark/gold = Ebda's own brand look) acceptable as a merchant-facing preset, or should it stay Ebda's showcase only?
4. Keep reference screenshots in-repo, or drop them once the families are designed?
