# Souq (سوق): the general retail and electronics template and its three looks

Souq is the Egyptian general-retail and electronics template: phones, appliances, accessories, a wide catalogue. It ships as three **looks** on one skin (`skin: 'souq'`, Ruling B2-1), `status: 'designed'` until Phase B2 Task 7 flips them. A store reaches `souq` only through a look (`StoreService.applyLook`), never as a bare skin choice (Ruling B1-17 repeated). Look data lives in `packages/shared/src/looks/registry.ts`; how looks work is `docs/ebda/templates/looks.md`; the binding rules are `docs/ebda/templates/quality-bar.md`; the direction is `2026-10-14-directions.md` and `research/souq.md`; B1's equivalent is `qamar.md`.

**There is no orange in Souq** (Ahmad 2026-10-16, extended to palettes: no saffron, no amber, no brass in the orange family; Ruling B2-2). Forbidden: hue 12-50 degrees at colour saturation >= 35%, in look tokens, in the UI the looks paint (including the platform warning, Ruling B2-12) and in generated photos.

## The three looks

|              | Catalogue (`souq.catalogue`)                | Night souq (`souq.night`)                                                   | Showroom (`souq.showroom`)                      |
| ------------ | ------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| Scene        | Many SKUs, shoppers who know what they want | A lit market after dark, warmth without clutter                             | A small premium range sold one object at a time |
| Colour       | Ink on white, cobalt `#1F5FD6`              | Deep green `#0F3B2E`, cream ink, turquoise `#5FD3C0`, pomegranate `#F57A83` | Soft grey page, ink, electric blue `#1D5CE6`    |
| Type         | IBM Plex Sans Arabic / IBM Plex Sans        | Changa / Cairo / Manrope                                                    | Alexandria / Readex Pro / Inter Tight           |
| Radius, etc. | md, compact, 1/1, subtle                    | md, regular, 1/1, expressive                                                | lg, airy, 1/1, subtle                           |
| Card action  | the skin's quick add                        | the skin's quick add                                                        | quiet outline add (`cardCta: 'quiet'`)          |

### Tokens and measured contrast (computed 2026-10-21, asserted in `tests/unit/souq-look-tokens.test.ts`)

| Pair                     | Catalogue | Night souq      | Showroom |
| ------------------------ | --------- | --------------- | -------- |
| ink on page              | >= 4.5    | 11.23           | >= 4.5   |
| muted on page            | >= 4.5    | 7.38            | >= 4.5   |
| onPrimary on primary     | 5.73      | 10.09           | 5.64     |
| onAccent on accent       | 5.73      | 6.98 (dark ink) | 5.89     |
| chip fill on card / page | n/a       | 3.55 / 4.74     | n/a      |
| primary as text on page  | 5.73      | 6.86            | 5.08     |

Night's pomegranate is a FILL with dark ink for sale and new chips (>= 3:1 against the card and the page). Inputs read `--input` (the muted ink), so a field boundary is >= 3:1 on every look.

## The STOP-1 alternative

If Ahmad prefers a warmer Night souq, `SOUQ_NIGHT_ALT_BRASS` (`packages/shared/src/looks/stop-alternatives.ts`, in no barrel) keeps brass `#C89B3C` for CTAs only (4.87:1 on the page) with the same green room and pomegranate chips. It is unwired: only the STOP-1 shot script reads it, and it ships only if Ahmad picks it (Ruling B2-2).

## Chrome (Task 2)

`apps/web/src/templates/souq/Header.tsx` wraps the minimal header and reads the look's `chrome.header.search`: Catalogue is **prominent** (Night souq and Showroom keep the icon search, Ruling B2-16) (one labelled search field, `role="search"`, 44px tall, with a themed clear button; under the logo row on a phone, in the centre column from `md`, the nav on a second row from `lg`).. The label is "دوّر على منتج أو ماركة" / "Search for a product or brand" (`LanguageContext` translations). The store name is the sized, untracked display wordmark (`wordmarkSize: 'lg'` on all three looks, so checkout shows the same one). `PACK_STYLES.souq` is the framed tile card with a two-line name, a firm price and one always-visible quick add; the `[data-pack='souq']` CSS sets the type voice only (no colour of its own, pinned by `souq-look-tokens.test.ts`).

## Section mixes (Task 4)

|                     | Catalogue                                                                     | Night souq                                                                                 | Showroom                                                                                             |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Order               | category rail, deals (`on_sale`), newest grid (4 / 2 cols), trust, newsletter | hero (full-bleed), category tiles, curated row, deals row, newest grid, trust, brand story | category chips, up to three one-product stages, hand-picked collection rectangles, 2-col grid, trust |
| No hero             | yes (search + categories are the first screen)                                |                                                                                            |                                                                                                      |
| Light band          |                                                                               | tiles + newest grid on `token:inverse`                                                     |                                                                                                      |
| Headings (Egyptian) | عروض النهاردة / لسه واصل                                                      | من السوق / عروض / جديد السوق                                                               | تسوّق حسب القسم / كل المنتجات                                                                        |

Mixes are data (`packages/shared/src/looks/registry.ts`); a section the incoming look does not use leaves the draft unless the merchant edited it, and design keys the outgoing look set return to the section default (rulings TPL-1, B1-45, B2-16). An unfilled stage renders nothing.

## Status of the build (Phase B2)

Task 1 (this page's first version): skin id, tokens, gates. Tasks 2-7 add the search-first header, dense-card pack, four platform variants (`rail`, `tiles`, `stage`, `on_sale`), the section mixes, the PDP instalment line, the `storedemo-souq` demo and the scenario matrix. This page is extended by the task that changes the behaviour it describes.
