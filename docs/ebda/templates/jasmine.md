# Jasmine (ياسمين): the beauty and skincare template and its three looks

Jasmine is the Egyptian beauty-and-skincare template: cleansers, serums, moisturisers, makeup, perfumes, hair care. It ships as three **looks** on one skin (`skin: 'jasmine'`, Ruling B3-1), `status: 'built'` (flipped in Phase B3 Task 5). A store reaches `jasmine` only through a look (`StoreService.applyLook`), never as a bare skin choice (Ruling B1-17 repeated). Look data lives in `packages/shared/src/looks/registry.ts`; how looks work is `docs/ebda/templates/looks.md`; the binding rules are `docs/ebda/templates/quality-bar.md`; the direction is `2026-10-14-directions.md` and `research/jasmine.md`; the model is `souq.md`.

**There is no orange, saffron or amber in Jasmine** (Ahmad 2026-10-16, taste profile 2026-10-21; Rulings B2-2, B3-2, B3-3). Forbidden: hue 12-50 degrees at colour saturation >= 35% (and the pale-tint rule), in look tokens, in the UI the looks paint (the platform warning is plum, not amber), in **shade swatches** (rose, berry, mauve, plum, dusty nude: never coral, terracotta or peach), in generated photos (pixel probe) and in rendered shots (page-wide probe). The ONE scoped exception is the Night-souq brass `#C89B3C` as Apothecary's CTA fill and chip fill (B3-2, the B2-18 allowlist gains exactly one entry). Warmth comes from metal, never from orange.

## The three looks

|              | Apothecary (`jasmine.apothecary`)                     | Bloom (`jasmine.bloom`)                        | Clinic (`jasmine.clinic`)                        |
| ------------ | ----------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| Scene        | Natural care trusted for its ingredients              | Colour cosmetics chosen by shade               | Actives for a concern the customer wants solved  |
| Colour       | Deep olive `#24291C`, paper ink, brass CTAs `#C89B3C` | Blush `#F6D7DC`, plum ink, raspberry `#B0154F` | White, ink, aqua band `#E6F5F2`, green `#1B7A67` |
| Type         | Amiri / Noto Sans Arabic / Fraunces                   | Rubik / Tajawal / DM Sans                      | Readex Pro / Readex Pro / Figtree                |
| Radius, etc. | sm (4px), regular, 4/5, subtle                        | lg (12px), regular, 1/1, expressive            | md (8px), airy, 1/1, subtle                      |
| Card action  | the skin's quick add                                  | the skin's quick add                           | quiet outline add (`cardCta: 'quiet'`)           |

### Tokens and measured contrast (computed 2026-10-22, asserted in `tests/unit/jasmine-look-tokens.test.ts`)

| Pair                     | Apothecary              | Bloom | Clinic |
| ------------------------ | ----------------------- | ----- | ------ |
| ink on page              | 12.99                   | 11.20 | 16.40  |
| muted on page            | 9.16                    | 6.51  | 7.33   |
| onPrimary on primary     | 7.03 (olive-black)      | 6.85  | 5.22   |
| primary as text on page  | 5.83 (brass)            | 5.11  | 5.22   |
| primary on the surface   | 5.02 (brass)            | 6.85  | 4.65   |
| accent as text on page   | 7.90 (jade)             | 5.11  | 5.22   |
| decorative `line` / page | 1.83 (never a boundary) | 1.22  | 1.28   |

Inputs read the composed `--input` (never the decorative line), so a field boundary is >= 3:1 on every look. Rulings B3-2 and B3-3 record why three plan values changed: the brown ground `#2E2A22` (41 degrees, HSV 26%) and the near-black brass ink `#1E1B14` were inside the band by the gate's own measurement, and `#1E7F6B` measured 4.35:1 on the aqua band.

Fix wave 1 (Ruling B3-13): Bloom's hero is `{ presentation:'framed', frame:'line', textAnchor:'bottom-start' }` (the photo fills the frame; copy stacks in ink below xl) and its grid is four across; Apothecary keeps the olive ground on the listing pages (`chrome.listing:'ground'`, photos on a paper matte); Clinic's order is chips, then the featured-active stage, then the routine, so a product photo is in the first screen. Tags are bilingual (`Tag.nameAr`, platform-commerce section 14).

## Signature section (T7)

`key-ingredients`: a photo beside the ingredients, one per line with what it does, in all three looks after the main grid. Fewer than two ingredients renders nothing; the preset holds none (Rulings T7-1, T7-2). Demo: jojoba, oats, green tea, shea.

## Chrome

`apps/web/src/templates/jasmine/Header.tsx` wraps the shared base header (`templates/base/Header.tsx`), logo-forward (`chrome.header: { logoPlacement: 'start', search: 'icon' }` on every look): the store name is the sized, untracked display wordmark (`wordmarkSize: 'lg'`). `PACK_STYLES.jasmine` is a rounded, photo-led card in the look's radius (`var(--radius)` only), one always-visible >= 44px quick add, with the shade dots and two fact chips from the shared card (Ruling B3-1: no card path was added). The `[data-pack='jasmine']` CSS sets the type voice only (no colour of its own, pinned by `jasmine-pack.test.tsx`).

## Section mixes (Task 4)

|                     | Apothecary                                                                                                         | Bloom                                                                                                   | Clinic                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Order               | hero, skin-type chips, newest rows on the LIGHT band, ritual band (`steps`, "The ritual"), trust                   | framed hero, "start here" rail, routine of the week (curated), shade grid, customer strip, deals, trust | concern chips FIRST, the 3-step routine, one featured active (stage), actives grid on the aqua surface, trust, newsletter |
| First screen        | the chips under the hero (hero capped at 45vh on a phone)                                                          | the rail under the framed hero                                                                          | the chips directly under the header                                                                                       |
| Photos              | merchant white photos sit on a paper matte (card photo, multiply) and the rows on the light band (quality bar 9.1) | n/a (light page)                                                                                        | n/a (light page)                                                                                                          |
| Headings (Egyptian) | حسب نوع بشرتك / مكوّنات تعرفها / الطقس                                                                             | ابدأ من هنا / روتين الأسبوع / كل الدرجات / عروض                                                         | اختار مشكلتك / روتينك في 3 خطوات / المواد الفعّالة                                                                        |

Mixes are data; a section the incoming look does not use leaves the draft unless the merchant edited it, and design keys the outgoing look set (including `source: 'tags'`) return to the section default (rulings TPL-1, B1-45). Tested in `tests/unit/jasmine-look-mix.test.ts` and, under `ebda_app`, in `tests/integration/store-look.test.ts`.

## Look briefs (Ahmad's taste profile: no orange, metallic warmth on deep grounds, premium base with playful details, merchandising that sells, Egyptian voice, photo-led)

**Apothecary.** Scene: a shelf of glass bottles and the ingredients they are made from. Colour strategy: committed deep olive with paper ink and ONE brass accent (CTA and chips); photos sit on a paper matte so a white-background merchant bottle never reads as a white box. Type: Amiri for Arabic headings (an apothecary's label), Noto Sans Arabic body, Fraunces Latin. Bold idea: the ingredient is the headline ("مكوّنات تعرفها") and the skin-type chips are the first thing under it. Playful detail: pressing a card's add control "unscrews the cap": a brass drop leaves the button and falls (static under reduced motion: no drop). Contrast: see the table.

**Bloom.** Scene: a blush shelf of tubes and compacts where the product colour is the page colour. Colour strategy: committed blush page with one raspberry action; the shade swatch is the hero of the card. Type: Rubik (Arabic and Latin display voice, playful), Tajawal body, DM Sans. Bold idea: choose by shade, so every card shows up to five shade dots then `+N`, and the PDP shade picker is the first selector. Playful detail: picking a shade pops its dot and shifts the page wash a tint toward the brand colour (the tinted end state stays under reduced motion).

**Clinic.** Scene: a clean white clinic wall with a routine on it. Colour strategy: restrained white and ink, one clinical green, an aqua band for the actives. Type: Readex Pro with Figtree (one calm family). Bold idea: the routine IS the navigation: concern chips, then "روتينك في 3 خطوات" backed by a real bundle with a real saving. Playful detail: a step ticks when its product is in the cart (static under reduced motion).

## Merchandising that sells (platform-commerce section 14)

Skin-type and concern **chips** (tags source), the **routine steps** section with a real "add all" and live bundle saving, a PDP **rating line** and a PDP **bundle-saving line** (neither on cards), the existing B2 deals row and instalment line. Ingredients, actives, PAO/expiry, skin type and how-to-use are B0 product facts by convention (Ruling B3-4). Deferred with reasons: Ruling B3-7.

## Demo, scenario matrix and pack (Phase B3 Tasks 5-6)

`storedemo-jasmine` (`demo-store.md`), the scenario stores (`scripts/storedemo/scenario-stores.mjs --template jasmine`), the browser suite `tests/jasmine/` with `playwright.jasmine.config.ts` (`JASMINE_PORT`, `JASMINE_HOST_BASE`), and the purchase-path pack (`scripts/taste/shoot-purchase-path.mjs --template jasmine`, `purchase-path.json`: category = a skin-type tag PLP, PDP = the Shade x Size lipstick whose variant names must reach the cart summary and the receipt).

## Status of the build (Phase B3)

Built: skin id, tokens and gates, the logo-forward header, the pack and the three playful details, the four platform pieces, the three mixes, the `storedemo-jasmine` demo and its catalogue, the scenario matrix and the pack. Rulings B3-1 to B3-10 are in `docs/RULINGS.md`.

## Storefront audit 2026-11-03 (PREMIUM-30, PREMIUM-34, PREMIUM-35)

The header lockup keeps its whole Latin word (an inline lockup stacks on a phone; a line that cannot fit collapses, never an ellipsis). Bloom card photos sit on a blush matte and multiply into it. A Clinic routine-step product row is a card row, not an underlined link.
