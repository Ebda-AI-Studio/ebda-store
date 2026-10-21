# Souq (سوق): the general retail and electronics template and its three looks

Souq is the Egyptian general-retail and electronics template: phones, appliances, accessories, a wide catalogue. It ships as three **looks** on one skin (`skin: 'souq'`, Ruling B2-1), `status: 'designed'` until Phase B2 Task 7 flips them. A store reaches `souq` only through a look (`StoreService.applyLook`), never as a bare skin choice (Ruling B1-17 repeated). Look data lives in `packages/shared/src/looks/registry.ts`; how looks work is `docs/ebda/templates/looks.md`; the binding rules are `docs/ebda/templates/quality-bar.md`; the direction is `2026-10-14-directions.md` and `research/souq.md`; B1's equivalent is `qamar.md`.

**There is no orange in Souq** (Ahmad 2026-10-16, extended to palettes: no saffron, no amber, no brass in the orange family; Ruling B2-2). Forbidden: hue 12-50 degrees at colour saturation >= 35%, in look tokens, in the UI the looks paint (including the platform warning, Ruling B2-12) and in generated photos.

## The three looks

|              | Catalogue (`souq.catalogue`)                | Night souq (`souq.night`)                                                   | Showroom (`souq.showroom`)                      |
| ------------ | ------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| Scene        | Many SKUs, shoppers who know what they want | A lit market after dark, warmth without clutter                             | A small premium range sold one object at a time |
| Colour       | Ink on white, cobalt `#1F5FD6`              | Deep green `#0F3B2E`, cream ink, turquoise `#5FD3C0`, pomegranate `#E8606A` | Soft grey page, ink, electric blue `#2A6BFF`    |
| Type         | IBM Plex Sans Arabic / IBM Plex Sans        | Changa / Cairo / Manrope                                                    | Alexandria / Readex Pro / Inter Tight           |
| Radius, etc. | md, compact, 1/1, subtle                    | md, regular, 1/1, expressive                                                | lg, airy, 1/1, subtle                           |
| Card action  | the skin's quick add                        | the skin's quick add                                                        | quiet outline add (`cardCta: 'quiet'`)          |

### Tokens and measured contrast (computed 2026-10-21, asserted in `tests/unit/souq-look-tokens.test.ts`)

| Pair                   | Catalogue | Night souq       | Showroom                 |
| ---------------------- | --------- | ---------------- | ------------------------ |
| ink on page            | >= 4.5    | 11.23            | >= 4.5                   |
| muted on page          | >= 4.5    | 7.38             | >= 4.5                   |
| onPrimary on primary   | 5.73      | 10.09            | 4.52                     |
| onAccent on accent     | 5.73      | 5.51 (dark ink)  | >= 4.5                   |
| accent as text on page | n/a       | 3.75 (fill only) | 5.0 (`#1B61FF` on white) |

Night's pomegranate is a FILL with dark ink for sale and new chips, never a text colour on the page. Inputs read `--input` (the muted ink), so a field boundary is >= 3:1 on every look.

## The STOP-1 alternative

If Ahmad prefers a warmer Night souq, `SOUQ_NIGHT_ALT_BRASS` (`registry.ts`) keeps brass `#C89B3C` for CTAs only (4.87:1 on the page) with the same green room and pomegranate chips. It is unwired: only the STOP-1 shot script reads it, and it ships only if Ahmad picks it (Ruling B2-2).

## Status of the build (Phase B2)

Task 1 (this page's first version): skin id, tokens, gates. Tasks 2-7 add the search-first header, dense-card pack, four platform variants (`rail`, `tiles`, `stage`, `on_sale`), the section mixes, the PDP instalment line, the `storedemo-souq` demo and the scenario matrix. This page is extended by the task that changes the behaviour it describes.
