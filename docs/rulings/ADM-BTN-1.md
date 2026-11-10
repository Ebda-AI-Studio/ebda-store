# ADM-BTN-1

> Section: 2026-11-10 — admin button system (branch `fix/admin-button-system`)

**Ruling ADM-BTN-1 — the merchant admin has ONE button primitive, `apps/admin/src/components/ui/Button.tsx`
(`Button` + `buttonVariants()`), and a guard keeps every other button from styling itself.**
Measured live on 2026-11-10 (13 admin pages, one store): at least 10 distinct button looks, heights
16/26/34/36/44/48 px, radius 0/9/12/14/pill, type 12/14/16 px, including a 16 px tall tap target
("إخفاء الدليل") — because 559 raw `<button>`s styled themselves and 46 `<Button>`s overrode the size.

The scale (heights mirror `@ebda/ui` Input, so a button and the field beside it line up):
`sm` 32 px / 13 px (rows, chips, pagination, segmented filters; 44 px hit area under 640 px via a
transparent `::before`), `md` 40 px / 14 px, 44 px under 640 px (the default), `lg` 44 px / 16 px
(sticky-footer primary, full-width phone CTAs); `icon-sm` 32, `icon` 40 (44 on phones), `icon-lg` 44.
One radius: `rounded-md` (`calc(var(--radius) - 2px)` = 12 px, the input radius). Variants: `default`
(gold fill, one per view), `outline`, `secondary`, `ghost`, `soft` (the selected segment/tab/chip),
`destructive`, `link`. No hover lift (Operate surface: no motion that means nothing). `type` is not
defaulted, exactly like the `@ebda/ui` Button it replaces in admin, so a swapped import never turns a
submit into a no-op.

Why admin-local and not a change to `@ebda/ui`'s Button: the storefront (`apps/web`) renders that one
in 29 places with its own 44/36/48 sizes and hover lift; changing it would restyle shoppers' stores.
Admin imports of the `@ebda/ui` Button are banned (rule B3).

Guard: `tests/unit/admin-button-system.test.ts` — B1 a raw `<button>` with height/padding/type-size/
radius/fill/border classes, B2 a `<Button>`/`buttonVariants()` className that overrides the scale,
B3 the storefront Button imported in admin. Non-button controls are exempt only by a true ARIA role
(switch, menuitem\*, option, radio, tab, gridcell) or `data-ui="swatch|tile|row|nav|canvas|handle"`,
both visible in the markup. `DEFERRED` holds `app/login/page.tsx` (PR #533 is rewriting the sign-in
pages) and may only shrink. Measured with `scripts/visual/admin-button-styles.mjs`.

Round 2 (controller review of the first push): every control in the page header row (language toggle,
notifications, view store, the "..." overflow, the primary) is `md` (40 px desktop, 44 px phone, 12 px radius);
list pagination is `md`; links dressed as buttons take `buttonVariants()` (rule B4), and classes appended beside
`buttonVariants()` are checked too (`cn(buttonVariants(), 'min-h-11')` was forcing 44 px on desktop). Measured
on 14 pages: 10 distinct styles, no pill (radius >= half the height) anywhere.

Cost if wrong: a control that should have kept a bespoke look now wears the scale (fix = an exempt
kind, visible in review), or a `data-ui` exemption is abused to dodge the guard (fix = review the
`data-ui=` grep, which is short by design).
