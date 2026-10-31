# Lamma (لمّة): the home food and home kitchen template and its three looks

Lamma is the Egyptian home-kitchen and grocery template: stuffed vegetables, tagines, grill and sweets, plus fresh produce, dairy and pantry basics. It ships as three **looks** on one skin (`skin: 'lamma'`, Ruling B4-1), `status: 'built'` (flipped in Phase B4 Task 7). A store reaches `lamma` only through a look (`StoreService.applyLook`), never as a bare skin choice (Ruling B1-17 repeated). Look data lives in `packages/shared/src/looks/registry.ts`; how looks work is `docs/ebda/templates/looks.md`; the binding rules are `docs/ebda/templates/quality-bar.md`; the direction is `2026-10-14-directions.md` and `research/lamma.md`; the plan is `docs/plans/2026-10-21-phase-b4-lamma.md`.

**There is no orange, saffron or amber in Lamma** (Ahmad 2026-10-16, taste profile 2026-10-21; Rulings B2-2, B4-2, B4-3). Forbidden: hue 12-50 degrees at colour saturation >= 35 % (the shared gate rounds the hue to a whole degree, B4-13: the direction's own terracotta measured 11.6), in look tokens, in the UI the looks paint (the platform warning is plum), in the **aisle tints**, in generated photos (the FOOD-calibrated probe: bread and crust are brown and pass, a glowing orange fails, B4-3) and in rendered shots. The ONE scoped exception is antique brass `#D3B87C` as the Notebook's primary/accent tokens (B4-2). The platform has a metal rule: HSL saturation <= 52 %, lightness 45-75 %.

## The three looks

|              | Family table (`lamma.table`)                                                                                    | Kitchen notebook (`lamma.notebook`)                      | Fresh market (`lamma.market`)                         |
| ------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| Scene        | A home kitchen taking same-day orders like a restaurant                                                         | One named cook who is the brand                          | Grocery and produce with repeat baskets               |
| Colour       | White, pomegranate clay `#A5303F`, herb `#3E7A3A` (the mock's herb, TEMPLATES-MOCK-9; was `#2F6B34`), rose tint | Deep green `#1F3D2B`, paper ink, antique brass `#D3B87C` | White, herb green `#23744A`, crimson tomato `#CC2F3F` |
| Type         | El Messiri / Cairo / Fraunces                                                                                   | Aref Ruqaa / Noto Sans Arabic / Lora                     | Baloo Bhaijaan 2 / Almarai / Nunito                   |
| Radius, etc. | md (8px), regular, 4/3, subtle                                                                                  | sm (4px), airy, 4/3, subtle                              | lg (16px), compact, 1/1, expressive                   |
| Card action  | the skin's add control, becomes a stepper in the cart                                                           | quiet outline add, becomes a stepper                     | the skin's add control, becomes a stepper             |

### Tokens and measured contrast (computed 2026-10-22, asserted in `tests/unit/lamma-look-tokens.test.ts`)

| Pair                     | Family table            | Notebook                | Market         |
| ------------------------ | ----------------------- | ----------------------- | -------------- |
| ink on page              | 16.53                   | 11.06                   | 17.22          |
| muted on page            | 7.46                    | 7.65                    | 7.23           |
| onPrimary on primary     | 6.79                    | 6.20 (green on brass)   | 5.72           |
| primary as text on page  | 6.79                    | 6.20 (brass)            | 5.72           |
| primary on the surface   | 5.73                    | 4.74 (brass)            | 5.20           |
| accent as text on page   | 6.42 (herb)             | 6.20 (brass)            | 5.19 (crimson) |
| decorative `line` / page | 1.38 (never a boundary) | 1.61 (never a boundary) | 1.27           |

Inputs read the composed `--input` (never the decorative line), so a field boundary is >= 3:1 on every look. Ruling B4-2 records every colour that changed from the directions (terracotta, saffron, tomato, the market's saffron section colour) and why.

## Chrome

`apps/web/src/templates/lamma/Header.tsx` wraps the shared base header (`templates/base/Header.tsx`) with the look's logo placement (`start` on Table and Market, `centre` on Notebook; the skin's icon search). `PACK_STYLES.lamma` is a photo-led card in the look's radius, one >= 44 px add control; the `[data-pack='lamma']` CSS sets the type voice only (no colour of its own). Every Lamma look also sets `chrome.cartBar: 'total'` and `chrome.cardStepper: 'inline'` (platform-commerce sections 15 and 16); Market sets `chrome.aisles`.

## Section mixes

|                     | Family table                                                                                         | Kitchen notebook                                                                                                             | Fresh market                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Order               | full-bleed hero, order again, the MENU (sticky category tabs, dish rows), the cook as a strip, trust | the cook LEADS (photo, "من مطبخ أم سلمى", story, hygiene line), order again, dishes 2-across on the LIGHT band, story, trust | aisle tiles (3 across on a phone), order again, deals today, a dense 5/2-across grid, trust |
| First screen        | the hero photo, then the menu                                                                        | the cook's photo and name                                                                                                    | the aisles                                                                                  |
| Photos              | dish photos on the page                                                                              | merchant white-background photos sit on the light band (`token:inverse`, quality bar 9.1), never on the green                | cut-outs on the page                                                                        |
| Headings (Egyptian) | منيو النهاردة / اطلب تاني                                                                            | من المطبخ النهاردة / اطلب تاني                                                                                               | اختار الممر / اطلب تاني / عروض النهاردة / طازة النهاردة                                     |

Mixes are data; `tint`, `tabs` and `variant` are look design keys (a switch resets them), and a section the incoming look does not use leaves the draft unless the merchant edited it (TPL-1, B1-45). Tested in `tests/unit/lamma-look-mix.test.ts` and, under `ebda_app`, in `tests/integration/store-look.test.ts`.

## Platform pieces Lamma introduced (shared by every skin)

The `menu` layout of `featured-collection` and the `maker-profile` section and `category-grid` `tint: 'aisles'` (`docs/architecture/page-definition.md`); the card stepper, the browse cart bar and minimum-order progress (platform-commerce 15-16); the customer `reorder` source and reorder-this-order (17); delivery date chips with server validation (18, `docs/architecture/store-checkout-settings.md`). None adds a card data path (Ruling B4-1).

## Look briefs (Ahmad's taste profile: no orange, metallic warmth on deep grounds, premium base with playful details, merchandising that sells, Egyptian voice, photo-led)

**Family table.** Scene: a Friday table with the dishes still steaming. Colour strategy: restrained white with ONE pomegranate action and a rose tint for bands. Type: El Messiri headings (a warm display), Cairo body, Fraunces Latin. Bold idea: order like a menu, not like a shop: category tabs, dishes as rows with portion and prep-time chips, a stepper in place of the add button once it is in the basket, a cart bar with the total and the minimum-order progress. Playful detail: the stepper's quantity is a live region; the delivery chips say "النهاردة" and "بكرة".

**Kitchen notebook.** Scene: a handwritten kitchen notebook. Colour strategy: committed deep green with paper ink and ONE antique-brass accent (the only metal). Type: Aref Ruqaa (handwritten Arabic), Noto Sans Arabic body (Ruling B4-16; Naskh read 8-9px), Lora Latin. Bold idea: the cook is the brand; her photo and story lead and the dishes follow on a light band so a white-background photo never reads as a white box on green.

**Fresh market.** Scene: a grocery aisle sign. Colour strategy: committed white with herb green and a crimson accent; the aisles are four soft tints (herb, crimson, aubergine, aqua) behind ink names. Type: Baloo Bhaijaan 2 (a friendly rounded display), Almarai, Nunito. Bold idea: everything in two taps: tiles, deals, a dense grid whose cards carry the stepper, an "order again" row, a cart bar. Playful detail: the aisle tint cycles; the add control grows into the stepper in place.

## Merchandising that sells

Order again (the customer's own last products), deals today (`on_sale`), a cart bar with the minimum-order progress, the stepper, date chips with real windows. Deferred with reasons: Ruling B4-5 (multi-select add-ons with price delta, sold-by-weight steppers, gift cards, per-day capacity, free-shipping progress, a pre-order calendar strip, the Notebook one-line story on tiles).

## Demo, scenario matrix and pack (Phase B4 Tasks 6-7)

`storedemo-lamma` (`demo-store.md`), the scenario stores (`scripts/storedemo/scenario-stores.mjs --template lamma`), the browser suite `tests/lamma/` with `playwright.lamma.config.ts` (`LAMMA_PORT`, `LAMMA_HOST_BASE`), the local setup script `scripts/lamma-demo/seed-local-hosts.sh`, and the purchase-path pack (`scripts/taste/shoot-purchase-path.mjs --template lamma`, `purchase-path.json`: category = the tagines menu page, PDP = the portion-variant stuffed cabbage box whose portion must reach the cart summary and the receipt; the checkout picks a date and a window before placing the COD order). The matrix also proves the data flow with a kunafa carrying an order note.

## Status of the build (Phase B4)

Built: skin id, tokens and gates, the header, the pack, the four platform pieces, the three mixes, the reorder source, the date chips, the demo and its catalogue, the scenario matrix and the pack. Rulings B4-1 to B4-14 are in `docs/RULINGS.md`. Not verified without a device: a real-phone walk; production: nothing is deployed from this branch.
