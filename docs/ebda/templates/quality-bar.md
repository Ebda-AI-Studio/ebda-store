# Template quality bar (binding for every template and every look)

Every template (Qamar, Souq, Jasmine, Lamma, Dahab) and every look inside it must pass these rules before a look moves to `built`. The rules extend the **B0 taste bar** (`docs/plans/2026-10-14-phase-b0-platform-commerce.md` § Taste bar: leave-out limits, the three motion moments, Arabic-first, the taste gate) and the shared bar in `2026-10-14-directions.md`. Neither is repeated here.

- **Source:** the B1 Qamar audits (`.superpowers/sdd/2026-10-15-phase-b1-qamar/taste/consolidated.md`). Ids in brackets point there.
- **Check column:** `test` = unit/integration · `lint` = a grep or ESLint gate in CI · `shot` = the screenshot matrix below · `critique` = the impeccable pass.
- **Labels:** **[gate pending]** = the gate is planned in `fix-waves.md` and does not exist yet; until it lands, a reviewer checks the rule by hand. **[ruling pending]** = waits on a decision listed in `consolidated.md`.

## 1. Commerce correctness

| Rule                                                                                                                                                                                                                                           | Check                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every card path (8 + Dahab + the 4 hand-built mappers) derives its CTA from real `variants` and effective stock. No mapper hard-codes `inStock: true` or drops `variants`; the 4 hand-built mappers go through `templates/adapters.ts`. [C-01] | test (card-path parity): `apps/web/src/templates/card-mappers-cta.test.tsx`                                                                                                                          |
| The cart API refuses a variant product without a `variantId` (`400 VARIANT_REQUIRED`, ar + en, also with backorder on); the guest→login sync skips that line. The client is never the only guard. [C-01]                                       | test (integration): `tests/integration/cart-variant-required.test.ts` + defence mutations `cart-add-variant-required`, `cart-sync-skips-variant-parent` (`tests/unit/cart-variant-required.test.ts`) |
| The primary buy or checkout action is never painted disabled for a recoverable reason. A tap leads to the missing choice. `disabled` means the item cannot be bought. [C-02]                                                                   | test + shot                                                                                                                                                                                          |
| The buy or checkout action is the heaviest element on its screen and keeps one label at every breakpoint. [C-03]                                                                                                                               | shot + critique                                                                                                                                                                                      |
| At most one fixed-bottom layer: a task bar replaces the tab bar while it is visible. Every fixed bar feeds `scroll-padding-bottom`. The PDP fold rule is measured with all fixed chrome present. [C-04]                                        | shot (390 fold) + test                                                                                                                                                                               |

## 2. Arabic and RTL

| Rule                                                                                                                                                           | Check                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Never `isRtl ? 'flex-row-reverse'`. Direction comes from `dir`; spacing uses logical utilities only. [R-01]                                                    | lint [gate pending]           |
| Signed numbers, percentages, ranges and codes inside Arabic text are `<bdi>`-isolated, and minus is U+2212. [R-02]                                             | test (render under `dir=rtl`) |
| Arabic never gets letter-spacing or uppercase (`globals.css` `:lang(ar)` rule stays). Arabic-capable text never uses `leading-none` or `leading-tight`. [R-07] | lint + zoomed shot            |
| Directional icons mirror through one utility; non-directional icons never mirror. Carousels progress from inline-start in both directions. [R-08, R-09]        | lint + shot                   |
| Counted nouns go through the one plural helper (`Intl.PluralRules`, six Arabic forms). Number + noun concatenation is banned. [Y-01]                           | test + lint                   |
| One Arabic register and one form of address per page. Platform control labels use neutral noun forms. [Y-02, ruling pending (e)]                               | critique                      |
| Every accessible name, title and alt goes through `t()`. There are no Latin-only names on an Arabic page. [R-05]                                               | test                          |

## 3. Accessibility

| Rule                                                                                                                                           | Check                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Text and badge contrast ≥4.5:1, measured as the **composited** colour (alpha included), for every look × every badge type. [K-01, K-03, K-04]  | test (CI contrast)                        |
| A fill is always paired with its on-token (`bg-primary` ⇒ `text-primary-foreground`). [K-02]                                                   | lint                                      |
| Input boundaries ≥3:1. The focus indicator is ≥2px at ≥3:1, never an underline or a low-alpha ring alone. [K-05, R-11]                         | test + keyboard shot                      |
| No visible text under 12px, and Arabic chrome labels use weight ≥400. [R-03]                                                                   | lint (`text-[9-11px]` = 0) [gate pending] |
| Every tappable control is ≥44×44 (visual size or hit area). [R-10]                                                                             | test (Playwright bbox)                    |
| Sheets and drawers use the one shared `Sheet` primitive (Escape, focus trap and return, scroll lock). Ad-hoc `role="dialog"` is banned. [R-04] | lint + test                               |
| One `Breadcrumbs` component everywhere (`nav > ol`, `aria-current`, hidden separators). [R-06]                                                 | lint                                      |
| One focusable link per card destination. A CTA's name includes the product name. [R-12]                                                        | test                                      |
| Form submit failure focuses the first invalid field. JS scrolling honours reduced motion. [R-13]                                               | test                                      |

## 4. Look tokens govern shared components

| Rule                                                                                                                                                                                                                                        | Check                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Precedence is merchant value > look token > skin baseline. A store with no look renders unchanged. [L-02]                                                                                                                                   | test + shot diff (minimal store) |
| `imageRatio`, `radius`, `accent`, `cardCta`, badge, wordmark size, over-photo material and card hover all come from the look. A shared component never hard-codes a radius, hue, glow shadow or font family. [L-01, L-12, K-01, K-06, T-01] | lint + shot                      |
| Every radius derives from `--radius`. `rounded-full` is allowed only on swatches, avatars and dots, with a comment. [K-06]                                                                                                                  | lint                             |
| A card control that only navigates is not rendered when the look says `cardCta: none`; the card is the link. A card button exists only for an action the photo tap cannot do. [L-01]                                                        | test                             |
| Badges take the look's accent and `--radius`. There is no red pill, no coloured shadow and no system green for success. [K-01, K-07]                                                                                                        | lint + shot                      |
| A look that exceeds design.md's compact caps does it only through its `density` token, with the documented ceilings. [L-03, ruling pending (b)]                                                                                             | shot + review                    |

## 5. Layout and hierarchy

| Rule                                                                                                                                                                                  | Check              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| A scrim covers the text block, not the photo: ≥60% of a hero stays unscrimmed, and contrast is measured inside the text box. [L-04]                                                   | test + shot        |
| On a phone, the PDP photo is never smaller than the same product's card photo. [L-03]                                                                                                 | shot               |
| A card row fills its container or is centred. It never has an orphan last row or an empty tail. Cards in a row share the price and action baselines. [L-05, L-06]                     | shot (820 + 1280)  |
| No text in a translucent box over a photo. Headings use `text-wrap: balance`. [L-10]                                                                                                  | shot + critique    |
| One entry point per destination on a screen (one menu trigger). [L-09]                                                                                                                | shot               |
| Shopper panels expand ≤4 groups. Merchant-only config such as page size is never shown. Colour filters show swatches. Range sliders draw one track. There is one clear action. [L-07] | test + shot        |
| A helper link sits ≤16px from the control it serves. [L-08]                                                                                                                           | shot               |
| Share is one control (native share first), never a row of brand logos. [L-11]                                                                                                         | critique           |
| Every storefront photo goes through the image pipeline with `sizes`. [L-10]                                                                                                           | lint (raw `<img>`) |

## 6. Typography

| Rule                                                                                                                                                          | Check             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| A text wordmark is ≥1.25× the largest header text and never smaller than body text. Checkout and receipt pages render the store's own header. [T-01, S-03]    | shot              |
| A high-contrast display face is used only at ≥24px, and never inside form or filter UI. [T-02, T-03]                                                          | shot + critique   |
| Section headings on a page share alignment, rule and case. The look decides them; English uses sentence case. [T-03]                                          | shot              |
| Amounts use the body face with tabular figures. Monospace only for machine codes. [T-04]                                                                      | shot              |
| Font picks are checked against impeccable's reflex-reject list. A hit needs a written Ruling. No two templates share a display face or aesthetic lane. [T-05] | critique + Ruling |
| A look never re-downloads a face the platform already self-hosts. Font CSS is preconnected and uses `display=swap`. [T-06]                                    | network trace     |

## 7. Motion

| Rule                                                                                                                                                                          | Check           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Show/hide bars use interruptible transitions with a faster exit, never keyframes plus unmount. Toggles use hysteresis. [M-02]                                                 | test            |
| Press feedback ≤160ms, transform or opacity only, does not count against the motion budget. [M-01, ruling pending (c)]                                                        | test            |
| No `transition-all`. No bounce. No hover lift on looks that declare `cardHover: none`. A rare celebratory animation (the receipt) can be skipped by a tap. [M-03, M-04, M-05] | lint + critique |

## 8. Copy and trust

| Rule                                                                                                                                                                                           | Check           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Only exceptions speak. A status that is true for almost every item ("in stock", "0/12") is not rendered. One fact, one place per screen. [Y-05]                                                | critique + shot |
| Every option label names the current selection. Every field says required or optional and carries an example in the shopper's language. [Y-03, Y-04]                                           | test            |
| No generated filler copy ("Browse X"). Empty means absent. [Y-06]                                                                                                                              | critique        |
| COD and the exchange policy sit within one scroll of the PDP CTA and in the footer. The receipt repeats the delivery window and offers WhatsApp. Nothing renders without merchant data. [S-02] | test + shot     |
| Every footer renders privacy, terms and returns from `resolveBottomBar`. [S-01]                                                                                                                | test            |
| Nothing imitates function: a barcode, handle or control that looks usable must work, or it is removed. [S-04, ruling pending (d)]                                                              | critique        |

## How to run the taste gate

Run it at the end of every template or look task, after the tests pass and before the commit. The B0 taste bar's gate still applies; this adds the order and the bar.

1. **Screens:** home, PLP, PDP (with an unselected size), cart (qty 1), checkout success and the filter sheet. Add OOS, empty-cart and failed-coupon states when the change touches them.
2. **Widths, in this order:**
   - **390×844 Arabic first** (full page + fold);
   - **820 Arabic**;
   - **1280×800 English**.

   Shoot each look changed, plus one no-look `minimal` store to prove its defaults did not move. Save the shots in the task's report directory.

3. **Skills, in this order:**
   1. `impeccable` **critique**, then **polish** (Nielsen score, anti-patterns, the polish checklist);
   2. `accessibility-review` + `impeccable` **audit** (WCAG AA tables, measured contrast);
   3. the design-craft lenses (`design-critique`, `apple-design`, `emil-design-eng`) for hierarchy, response and motion.

   Each pass judges the 390-ar shots first. Merge the findings with a dedupe step.

4. **Pass bar:**
   - **no open P0 or P1**;
   - impeccable critique **≥ 28/40** (Atelier scored 21/40 on 2026-10-15);
   - every rule above is `done (evidence)` or carries a Ruling with cost-if-wrong.

   A P2 left open is written as a Ruling, never left only in chat.

5. **Re-check:** list which earlier findings still hold, so a fixed item is not silently re-opened.
