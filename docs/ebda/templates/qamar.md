# Qamar (قمر): the fashion template and its three looks

Qamar is the Egyptian fashion template: abayas, kaftans, evening and occasion wear, scarves. It ships as three **looks** on one skin (`skin: 'qamar'`, Ruling B1-1), all `status: 'built'` since Phase B1 Task 10 (Ahmad approved them at STOP 2, 2026-10-21). A store reaches `qamar` only through a look (`StoreService.applyLook`), never as a bare skin choice (Ruling B1-17). Look data lives in `packages/shared/src/looks/registry.ts`; how looks work is `docs/ebda/templates/looks.md`; the binding rules are `docs/ebda/templates/quality-bar.md`; the research and direction are `research/qamar.md` and `2026-10-14-directions.md`.

## The three looks

|                                      | Atelier (`qamar.atelier`)                                                                    | Lookbook (`qamar.lookbook`)                                                                                                                                                     | Vitrine (`qamar.vitrine`)                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Scene                                | A boutique whose clothes speak alone: a quiet white room, the model is the interface         | A stylist who sells whole outfits: a dark indigo room, outfits shown as collages                                                                                                | Occasion wear: a lit window, you shop by wedding, engagement, evening                                     |
| For whom (ar / en)                   | لبوتيك هدومه بتتكلم لوحدها / a boutique whose clothes speak alone                            | للستايلست والمحلات اللي بتبيع لوك كامل / stylists who sell whole outfits                                                                                                        | لهدوم المناسبات: فرح وخطوبة وسهرة / occasion wear                                                         |
| Colour strategy                      | Restrained: ink on white, one oxblood accent for sale/new chips                              | Committed dark: indigo page, moon-silver accent (Ahmad's STOP 2 pick, Ruling B1-102)                                                                                            | Drenched in two small bands: teal primary, dusty rose accent, champagne hairlines                         |
| Type (display / body / Latin)        | Noto Naskh Arabic / IBM Plex Sans Arabic / Cormorant Garamond                                | Lalezar / Tajawal / Archivo                                                                                                                                                     | Aref Ruqaa / Noto Sans Arabic / Playfair Display                                                          |
| Radius, density, image ratio, motion | none, airy, 3/4, subtle                                                                      | md, regular, 4/5, expressive                                                                                                                                                    | sm, regular, 3/4, subtle                                                                                  |
| The bold idea                        | Oversized photography with the copy under the photo, almost no chrome; the photo is the card | Collage hero, shop-the-look panels (each piece links to its PDP; one "Shop this look" page lists a panel's pieces side by side), a light band for merchant photos shot on white | A framed hero whose champagne hairline draws in once, full-width occasion bands, a centred Ruqaa wordmark |
| Chrome                               | header logo at the start                                                                     | header logo at the start                                                                                                                                                        | header logo centred                                                                                       |

### Tokens and measured contrast

All pairs are asserted in `tests/unit/qamar-looks-contrast.test.ts` and `looks-contrast.test.ts` (text >= 4.5:1, UI >= 3:1, nothing under 12px). Ratios below were computed from the registry with `contrastRatio` on 2026-10-21.

| Token pair                     | Atelier | Lookbook | Vitrine                       |
| ------------------------------ | ------- | -------- | ----------------------------- |
| ink on page                    | 18.42   | 13.73    | 15.91                         |
| ink on surface                 | 18.42   | 11.20    | 17.33                         |
| muted on page                  | 6.69    | 8.65     | 6.77                          |
| onPrimary on primary           | 18.42   | 11.23    | 9.23                          |
| accent fill carries (onAccent) | 11.10   | 11.23    | 6.23 (ink on dusty rose)      |
| accent on page (as text)       | 11.10   | 11.23    | 2.55 (never used as text)     |
| line on page (hairline only)   | 1.25    | 1.61     | 1.74 (champagne, Ruling B1-5) |

Inputs read `--input` (a muted ink) so a field boundary is >= 3:1 on every look (Ruling B1-43). Inside Lookbook's light inverse band, primary, accent and the status inks are re-derived against the band (Rulings B1-67, B1-102, B1-113).

### Section mixes (from the registry)

- **Atelier:** full-bleed hero (copy bottom-start) , category chips (tight), new-in grid (4 / 2 columns), full-bleed image break, product carousel, brand story.
- **Lookbook:** collage hero, shop-the-look (card ground), category photo row and new-in grid on the inverse band, testimonials.
- **Vitrine:** framed hero (line frame, copy bottom-start), occasion bands, "In the window" grid, single testimonial.

Mixes apply through `applyTemplateFamily(def, 'qamar', look)`; a merchant's own sections and content survive a look switch (`design: 'keep'`), and `reset` applies the look whole.

### Motion (Ruling B1-7)

Two look-level entrance moments, each once, <= 600 ms, ease-out-quint, and none under `prefers-reduced-motion` (the final state shows): Lookbook's collage settle (the first photo only slides, so LCP is not delayed) and Vitrine's hairline draw-in. Atelier has none. Card hover lift is Lookbook only (`cardHover`, B1-60). The hero clip is absent under reduced motion (`qamar-matrix.spec.ts`).

### What was left out, and why

- Shop-the-look "add the whole look" in one tap: every piece needs a size (B1-6, amended B1-53 by the "Shop this look" list page).
- Lookbook card quick add: fashion cards route to the PDP for a size anyway (B1-21).
- Atelier press-logo strip: a new merchant has no press, and the taste bar forbids placeholders (B1-22).
- Product-card control on Atelier: the photo is the card, the card is the link (B1-60, L-01).

## The skin's files

`apps/web/src/templates/qamar/` (Header, hero variants, `HeroVideo`, collage, band tiles, footer), the shared look-aware card/section code in `apps/web/src/templates/shared/` (`look-card.ts`, `section-bg.ts`, `footer-ink.ts`), the look tokens in `packages/shared/src/looks/`, the checkout/receipt styling in `apps/web/src/app/checkout/`. The "Shop this look" page is `apps/web/src/app/looks/[sectionId]/[blockId]/`.

## Demo catalogue and assets

The Qamar demo boutique (`scripts/qamar-demo/catalogue.mjs`: 18 products, 160 variants) shows every B0 feature once, with illustrative AI photos (Ruling TPL-3) served from `QAMAR_DEMO_ASSET_BASE` (B1-9, B1-10, B1-16). Seed, assets and the production run: `docs/ebda/templates/demo-store.md`.

## Tests and how to run the matrix

- Unit: `tests/unit/looks-built-qamar.test.ts` (exactly the Qamar looks are built, each with skin, mix and chrome), `qamar-looks-contrast.test.ts`, `qamar-lookbook-w2a.test.tsx`, `payment-step-card.test.tsx` (card + COD on a Lookbook store, B1-20), `DemoLookBar.test.tsx` (real registry lists the three), `LookPicker.test.tsx` (opens on Qamar).
- Browser: `tests/qamar/` with `playwright.qamar.config.ts` (phone-390, tablet-820, desktop-1280). Seed the stores (`seed.mjs --local-look-stores`, then `scenario-stores.mjs`), start the stack and the host proxy, then `QAMAR_PORT=<port> QAMAR_NO_MIDDLEWARE=1 npx playwright test -c playwright.qamar.config.ts`. Detail and limits: `demo-store.md` § Plan, scenario stores and the browser suite.
- Purchase path: `scripts/taste/shoot-purchase-path.mjs` over `purchase-path.json` (quality bar § 10 rule (a)).
- Security: `npm run test:defence-mutations` (the demo guards have record entries).

## Review-round log

- STOP 1 (Atelier, Ahmad): reviewed live; the critique fixes are Rulings B1-26..B1-31 (hero scrim, footer ink, one price, PDP title).
- STOP 1b (Lookbook + Vitrine, 2026-10-16): approved.
- Independent audits 2026-10-16 (taste 24 / 25 / 24 then 28 / 27 / 28; a11y 0 P0 / 9 P1 then 4 P1): all findings fixed in W4-W6 (Rulings B1-70..B1-98).
- STOP 2 (2026-10-21): independent audit 30 / 29 / 30, Ahmad approved all three; Lookbook accent moon silver, Vitrine re-graded hero, receipt printer box kept (B1-93, B1-102).
- Task 10: the scenario matrix found size-chart scroll focus, auth inline links, band status inks, a showroom plan gap and a seed sale-price gap (Ruling B1-112, B1-113); one accepted residual (B1-111).

## Header chrome override (Ruling EP-4, Task 10)

`templates/qamar/Header.tsx` draws the logo placement the merchant chose in the visual editor's Theme pane (`theme.headerLogoPlacement`), else the look's `chrome.header.logoPlacement` (Atelier and Lookbook start, Vitrine centre), through `resolveHeaderChrome`. A store with no override draws exactly what its look says. Switching look with `design: 'reset'` clears the override; `keep` leaves it. Detail: `docs/architecture/store-theme-flags.md`.

## Storefront audit 2026-11-03 (PREMIUM-30, PREMIUM-37)

The lockup's display name keeps clip room for its marks (Lookbook's wordmark was cut at the top) and the Latin line is never truncated. The look-bundle strip peeking the next panel is intentional.
