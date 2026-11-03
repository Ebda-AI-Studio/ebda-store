# Souq (سوق): the general retail and electronics template and its three looks

Souq is the Egyptian general-retail and electronics template: phones, appliances, accessories, a wide catalogue. It ships as three **looks** on one skin (`skin: 'souq'`, Ruling B2-1), `status: 'built'` (flipped in Phase B2 Task 7). A store reaches `souq` only through a look (`StoreService.applyLook`), never as a bare skin choice (Ruling B1-17 repeated). Look data lives in `packages/shared/src/looks/registry.ts`; how looks work is `docs/ebda/templates/looks.md`; the binding rules are `docs/ebda/templates/quality-bar.md`; the direction is `2026-10-14-directions.md` and `research/souq.md`; B1's equivalent is `qamar.md`.

**There is no orange in Souq** (Ahmad 2026-10-16, extended to palettes: no saffron, no amber, no brass in the orange family; Ruling B2-2). Forbidden: hue 12-50 degrees at colour saturation >= 35%, in look tokens, in the UI the looks paint (including the platform warning, Ruling B2-12) and in generated photos.

## The three looks

|              | Catalogue (`souq.catalogue`)                | Night souq (`souq.night`)                                       | Showroom (`souq.showroom`)                      |
| ------------ | ------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| Scene        | Many SKUs, shoppers who know what they want | A lit market after dark, warmth without clutter                 | A small premium range sold one object at a time |
| Colour       | Ink on white, cobalt `#1F5FD6`              | Deep green `#0F3B2E`, cream ink, brass CTAs and chips `#C89B3C` | Soft grey page, ink, electric blue `#1D5CE6`    |
| Type         | IBM Plex Sans Arabic / IBM Plex Sans        | Changa / Cairo / Manrope                                        | Alexandria / Readex Pro / Inter Tight           |
| Radius, etc. | md, compact, 1/1, subtle                    | md, regular, 1/1, expressive                                    | lg, airy, 1/1, subtle                           |
| Card action  | the skin's quick add                        | the skin's quick add                                            | quiet outline add (`cardCta: 'quiet'`)          |

### Tokens and measured contrast (computed 2026-10-21, asserted in `tests/unit/souq-look-tokens.test.ts`)

| Pair                     | Catalogue | Night souq      | Showroom |
| ------------------------ | --------- | --------------- | -------- |
| ink on page              | >= 4.5    | 11.23           | >= 4.5   |
| muted on page            | >= 4.5    | 7.38            | >= 4.5   |
| onPrimary on primary     | 5.73      | 7.16 (brass)    | 5.64     |
| onAccent on accent       | 5.73      | 6.98 (dark ink) | 5.89     |
| chip fill on card / page | n/a       | 3.55 / 4.74     | n/a      |
| primary as text on page  | 5.73      | 4.87 (brass)    | 5.08     |

Night's sale / new chips and the PDP discount pill are the same brass with dark ink (4.87:1 on the page, 7.16:1 for the ink; Ruling B2-26: one accent, no coral). Inputs read `--input` (the muted ink), so a field boundary is >= 3:1 on every look.

## Night souq's brass (Ruling B2-18)

Ahmad chose brass CTAs for Night souq at STOP-1 (2026-10-21). Brass `#C89B3C` (hue 41) is in the forbidden hue band, so the no-orange gate carries ONE scoped exception: that exact hex, only as `souq.night`'s primary CTA tokens (look token `primary` and the theme / CSS roles that carry it: `primaryColor`, `ringColor`, `--primary`, `--ring`). Every other Night token, every other look and every other hex stay gated (`tests/unit/souq-look-tokens.test.ts`: brass passes only there, the same hex fails anywhere else, a real orange or an off-by-one brass fails even on Night primary). The turquoise alternative path was deleted.

## Chrome (Task 2)

`apps/web/src/templates/souq/Header.tsx` wraps the shared base header (`templates/base/Header.tsx`) and reads the search placement the merchant chose in the editor's Theme pane (`theme.headerSearch`, Ruling EP-4), else the look's `chrome.header.search`: Catalogue is **prominent** (one labelled search field, `role="search"`, 44px tall, with a themed clear button; under the logo row on a phone, in the centre column from `md`, the nav on a second row from `lg`); Night souq and Showroom keep the skin's **icon** search (Ruling B2-16). The label is "دوّر على منتج أو ماركة" / "Search for a product or brand" (`LanguageContext` translations). The store name is the sized, untracked display wordmark (`wordmarkSize: 'lg'` on all three looks, so checkout shows the same one). `PACK_STYLES.souq` is the framed tile card with a two-line name, a firm price and one always-visible quick add; the `[data-pack='souq']` CSS sets the type voice only (no colour of its own, pinned by `souq-look-tokens.test.ts`).

## Section mixes (Task 4)

|                     | Catalogue                                                                     | Night souq                                                                                                                                                            | Showroom                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Header search       | prominent field                                                               | icon                                                                                                                                                                  | icon                                                                                                              |
| Order               | category rail, deals (`on_sale`), newest grid (4 / 2 cols), trust, newsletter | hero (full-bleed, champagne lanterns), one featured-product stage, category tiles (4 across, brass hairline), curated row, deals row, newest grid, trust, brand story | category chips, up to three one-product stages, hand-picked collection rectangles, 4-up grid (2 on phones), trust |
| No hero             | yes (search + categories are the first screen)                                |                                                                                                                                                                       |                                                                                                                   |
| Light band          |                                                                               | none: Night stays green on every page; photos sit on a cream matte, multiplied (B2-23, B2-24)                                                                         |                                                                                                                   |
| Headings (Egyptian) | عروض النهاردة / لسه واصل                                                      | من السوق / عروض / جديد السوق                                                                                                                                          | تسوّق حسب القسم / كل المنتجات                                                                                     |

Mixes are data (`packages/shared/src/looks/registry.ts`); a section the incoming look does not use leaves the draft unless the merchant edited it, and design keys the outgoing look set return to the section default (rulings TPL-1, B1-45, B2-16). An unfilled stage renders nothing.

## Look briefs (Ahmad's taste profile, 2026-10-21: no orange, metallic warmth on deep grounds, premium base with playful details, Egyptian voice, photo-led)

**Catalogue.** Scene: a shopper who knows the model number and wants it in two taps. Colour strategy: restrained, one cobalt accent on white, the photo is the colour. Type: IBM Plex Sans Arabic with IBM Plex Sans (one family, tabular prices). Bold idea: the search field IS the first screen, with the category rail under it and no hero. Mix: rail, deals (`on_sale`), newest 4-up, trust, newsletter. Motion: subtle (200 ms, no parallax). Contrast: ink on page 17.0:1, muted 6.9:1, white on cobalt 5.73:1.

**Night souq.** Scene: a covered market after dark, lanterns lit. Colour strategy: committed, deep green ground, cream ink, brass CTAs (B2-18; metallic warmth, never orange), brass chips (B2-26); merchant white-background photos sit on a cream matte, multiplied into it (B2-24, B2-28). Type: Changa (Arabic display), Cairo (body), Manrope (Latin). Bold idea: the champagne-lantern arcade hero (generated, empty, 0.1% orange) over a green ground with one brass button, then one featured product. Mix: hero, one stage, category tiles, curated and deals rows, newest grid, trust, brand story. Motion: expressive but reduced-motion safe. Contrast: ink 11.23:1, muted 7.38:1, ink on brass 7.16:1, brass on page 4.87:1 (text on a card 3.65:1, so re-inked there, B2-20).

**Showroom.** Scene: a small premium range sold one object at a time. Colour strategy: restrained soft grey, ink, one electric-blue action. Type: Alexandria (Arabic display), Readex Pro, Inter Tight. Bold idea: each product is a full-width stage (photo, two facts, price, Choose options and Compare), categories as chips under the header. Mix: chips, up to three stages, hand-picked collection, 4-up grid (2 on phones), trust. Motion: subtle. Contrast: blue `#1D5CE6` 5.08:1 on the page, 5.64:1 under white.

## Instalment line

`settings.instalments` (platform-commerce section 13) renders on the PDP only, "تقسيط من ... في الشهر على 12 شهرًا · تقريبي", in the price row. Measured at 390 on the demo phone (price range, instalment line, first selector and the sticky add-to-cart bar all inside the first 844px, shots in the STOP-2 pack).

## Status of the build (Phase B2)

Built: skin id, tokens and gates, the search-first header, the dense-card pack, four platform variants (`rail`, `tiles`, `stage`, `on_sale`), the section mixes, the PDP instalment line, the `storedemo-souq` demo, the scenario matrix (`tests/souq/`, `playwright.souq.config.ts`, `scripts/storedemo/scenario-stores.mjs --template souq`) and the purchase-path pack (`scripts/taste/shoot-purchase-path.mjs --template souq`). STOP-2 fix wave 1 (B2-23, B2-24): auto-fill listing grid (`chrome.plp`), Night green throughout (`chrome.listing`), compact title band for a look store without a hero photo, sticky-header focus offset, per-product stage control names. Rulings B2-1 to B2-24 are in `docs/RULINGS.md`.

## Storefront audit 2026-11-03 (PREMIUM-33)

Night souq's hero action is the brass primary pair like the card actions; the header lockup follows PREMIUM-30.
