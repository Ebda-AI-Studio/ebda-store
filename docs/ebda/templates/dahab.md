# Dahab (دهب) — jewellery template (Phase B5)

Dahab is the Egyptian jewellery template: **three looks on one neutral skin**. It replaced the night + gold + arch skin of the builder pilot (Ruling TPL-2; the old skin, its Unsplash photos, its preview stack and its seed are removed in Phase B5, Task 7). The decisions and their reasons are in `docs/RULINGS.md` (B5-0 to B5-25); this page says what shipped.

| Look                 | Id               | For                                                 | Idea                                                           |
| -------------------- | ---------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Worn (على الإيد)     | `dahab.worn`     | a jeweller whose customers ask about size and karat | worn, not displayed: the size and the karat are always visible |
| Workshop (الورشة)    | `dahab.workshop` | a handmade silver studio                            | the making is the product                                      |
| Gift box (علبة هدية) | `dahab.giftbox`  | gift buyers who start with who and how much         | shop by recipient and budget                                   |

The skin id stays `dahab` (`stores.template = 'dahab'`, Ruling B5-1); only its visual language was replaced. A store on the skin with no look renders the neutral base (white page, ink primary, plum warning, `TEMPLATE_THEMES.dahab`), never a broken page.

## Tokens (re-derived under the no-orange gate, Ruling B5-2)

Brass and antique gold are metal, not orange (Ruling METAL-1), but no Dahab look needs them: the accents are rose gold, enamel and silver. Contrast is measured, not claimed (`tests/unit/dahab-look-tokens.test.ts`).

|                                | Worn                                           | Workshop                                   | Gift box                   |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------ | -------------------------- |
| Page                           | `#FFFFFF`                                      | `#0F4C4A` (committed teal)                 | `#FFFFFF`                  |
| Surface                        | `#F6F6F6`                                      | `#135957`                                  | `#F2C9C4`                  |
| Ink / on page                  | `#121212`, 18.73:1                             | `#FFFFFF`, 9.75:1                          | `#16201C`, 16.70:1         |
| Muted on page                  | 6.90:1                                         | 7.25:1                                     | 7.21:1                     |
| Primary (button)               | `#121212`, 18.73:1                             | `#E4E7EB` silver, 7.86:1                   | `#0E5C46` emerald, 7.96:1  |
| Accent                         | `#8F4F59` rose gold, 6.12:1                    | `#9FD8CB` enamel, 6.11:1                   | `#7A4049`, 7.90:1          |
| Fonts (display / body / latin) | Reem Kufi / IBM Plex Sans Arabic / Bodoni Moda | Markazi Text / Almarai / Libre Caslon Text | Kufam / Tajawal / Italiana |
| Radius, density, ratio, motion | none, airy, 4/5, subtle                        | sm, regular, 1/1, subtle                   | md, regular, 1/1, subtle   |

The old fonts (Amiri, Marcellus) are gone from `layout.tsx`. The Workshop page is committed teal, so a merchant photo on a white ground sits on a LIGHT band (quality bar section 9 rule 1, tested by `dahab-white-photos`). No glass and no blur anywhere in the skin (the old header, drawers, carousel and PDP bar are flat), no arch frame, no `dahab-draw` rule.

## Section mixes

- **Worn:** hero, category chips (the navigation sits right under the hero), featured collection "بتتلبس كل يوم", image-with-text "اسمك محفور عليها" (a link to a personalised piece), carousel "وصل حديثاً", reviews, story.
- **Workshop:** hero, **the journey of a piece** (`steps`, reused from Jasmine with the mix's own three blocks: رسم، صب، تلميع, Ruling B5-8), featured collection on `token:inverse` "بتتعمل بالطلب", image-with-text, collection list (rectangle tiles), trust badges, story.
- **Gift box:** hero, **the gift finder** (below), featured collection, image-with-text "بنغلّفها لحد باب الفرح", carousel, trust badges, newsletter.

New platform sections: `gift-finder` (occasions link to categories, budgets are whole pounds; a budget link opens the PLP with `maxPrice`, Ruling B5-7, `GiftFinderSection.tsx`) and the `blocks` field of a mix section spec (a look can ship its own blocks). The collection tile shape `arch` stays in the Zod enum for old data but is no longer offered in the editor; it renders as a rectangle. `docs/architecture/page-definition.md` has the schema.

## Signature section (T7)

`piece-window`: one piece in a double hairline frame (the line token), its name, a line and a button, in all three looks after the main grid. With no photo the frame holds the words. The journey strip stays `steps` on Workshop (Ruling B5-8; Rulings T7-1, T7-2). Demo: the solitaire ring.

## Conventions (what a Dahab merchant fills in)

- **Karat, width and weight are product facts** ("عيار 21", "عرض 4 مم", "الوزن 3.2 جم"), at most two on the card (Ruling B5-5). A gold-rate piece's karat and weight come from its spec; the admin warns when a fact names another karat.
- **Gift wrap is a variant option**, the card message is personalisation (optional), engraving is personalisation (required, "الحروف للحفر", max 12) (Ruling B5-4). Nothing is a new schema.
- **Ring sizes** use the "مقاس الخاتم" size chart through the category; **metal** is a swatch option (silver, rose gold, champagne). A yellow-gold swatch would fail the orange gate and is not offered.
- **Made to order** is the lead time (3 to 7 days) and the computed delivery chip.
- The **3D viewer** slot works on Dahab (it was missing: the Dahab PDP never passed `mediaSlot`, Ruling B5-1 finding).

## Gold-rate pricing

A product can be priced from today's gold rate. It is a platform feature (every template), not a Dahab one; the Dahab PDP prints the rate line under the price. Map, formula, cache layers, failure codes and runbook: `docs/architecture/gold-rate-pricing.md`; merchant surface: `docs/ebda/templates/platform-commerce.md` § Gold-rate pricing.

## Legacy Dahab stores

`template = 'dahab'` with `look IS NULL` is the retired skin. It cannot crash (neutral base). `scripts/dahab-demo/migrate-legacy-dahab.mjs` moves such stores onto a look through `StoreService.applyLook(..., { design: 'keep' })`, the real merchant path: dry run by default, loopback guard, `--yes-production` is Ahmad's to pass, idempotent, a store with a builder revision gets a DRAFT the merchant publishes (Ruling B5-3). Production had 0 such rows on 2026-10-21. The scenario store `dahab-legacy` rehearses it in the browser matrix.

## Demo store and tests

`storedemo-dahab` (`docs/ebda/templates/demo-store.md`, the fifth demo store, Rulings B5-10 to B5-12), 21 unbranded pieces, six of them priced from the gold rate. Scenario stores: `scripts/storedemo/scenario-stores.mjs --template dahab` (empty, one product, 500, no photo, long names, edge colours, three logo shapes, white photos, COD, legacy, and `dahab-gold*` whose owner can log in). Browser suite: `tests/dahab/` with `playwright.dahab.config.ts` (`DAHAB_PORT`, `DAHAB_HOST_BASE`; local setup `scripts/dahab-demo/seed-local-hosts.sh`): the scenario matrix, the Worn chips, the Workshop steps, the Gift box finder, required engraving, the gold line on every surface, the checkout data flow (a Metal x Size ring, an engraved ring and a gold chain must reach the cart, the receipt and the order), and `dahab-gold-price.spec.ts` (the merchant moves the rate through the admin API, the shopper sees "السعر اتحدّث", Continue, the snapshot, the stale case). The purchase-path pack: `scripts/taste/shoot-purchase-path.mjs --template dahab` (17 screens plus the two gold screens, at 390-ar and 1280-en, per look).

## Deferred (with reasons: Ruling B5-9)

Appointment booking, buy-now-pay-later, a certificate row (a fact by convention), "only 1 left", build-a-stack; per-customer-group gold price lists, silver and platinum rates, buy-back and trade-in.

## Storefront audit 2026-11-03 (PREMIUM-31, PREMIUM-32)

Below `lg` the hero is as tall as its content (photo block plus the copy in the flow; slider slides share one grid cell), so no dead white sits under the button. The showroom seeds gold pieces with a 10 EGP rounding step (`roundingStep: 1000`). Card actions are solid `bg-background` buttons and every target is 44px (measured, 390).
