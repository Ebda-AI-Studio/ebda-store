# Templates + editor program (launch gate) — 2026-10-14

Ahmad, 2026-10-14: Ebda Store does not launch until Qamar, Souq, Jasmine and Lamma are built, tested in every scenario and look stunning. The templates and the editor are designed as ONE system ("like Apple devices with iOS"): each template ships complete, and the editor supplies whatever a merchant's own style needs. Product context: `PRODUCT.md`. Prior decisions: `docs/plans/2026-10-07-ebda-visual-builder-roadmap.md` (Rulings BUILDER-1..4: extend the existing builder; Plasmic = reference for component registration/props/slots/variants/responsive editing/tree-canvas sync/history, MIT parts outside `platform/` reusable after license check, AGPL core never; Webstudio = reference for content vs design modes and token inheritance).

## Finish line
- **Must work:** a merchant picks any of the 5 templates at onboarding, gets a complete store that looks like an established brand, and can restyle it toward their own taste (colour roles, type pair, radius, density, image shape, section mix) in the editor without breaking it; the shopper side works on every device in Arabic and English.
- **Exercised:** each template × {390, 820, 1280} × {ar, en} × the scenario matrix below, via Playwright visual + a11y runs, plus a manual walk on a real phone; the editor flows below on desktop and phone.
- **Must not change:** checkout, pricing, inventory, permissions, tenant isolation, existing stores' published pages, Dahab's look.
- **Done when:** all checks green in CI, `impeccable critique` ≥ the bar for every template and the editor with zero P0/P1, Ahmad signs off each template after a live review round, and the inherited FWB skins (modern, classic, minimal, bold, elegant) are deleted with no store left on them.

## Phase D — directions → looks (decided)
Round 1 produced 3 directions per template (`docs/ebda/templates/2026-10-14-directions.md`, gallery https://claude.ai/artifact/Xqg35JTvMtrMddaAufvJkg).

**Ruling TPL-1 — every direction ships; none is dropped.** Ahmad, 2026-10-14: each template carries all 3 directions as selectable **looks** (Qamar: Atelier / Lookbook / Vitrine; Souq: Catalogue / Night souq / Showroom; Jasmine: Apothecary / Bloom / Clinic; Lamma: Family table / Kitchen notebook / Fresh market). The merchant picks a look at onboarding or later in the editor, then edits everything. Dahab keeps its one look for now (a second/third Dahab look is a later call). Evidence: the launch rule's goal "fit every person's style" is better served by 3 starting points per vertical than 1. Cost if wrong: 12 looks instead of 4 roughly triples design + scenario-test work before launch.

Consequences:
- A **look** = a token set (colour roles, type pair, radius, density, image ratio, motion) + a section mix + per-section variant choices + layout topology. It is data over the shared section registry, never a forked skin; commerce logic stays in shared components (Dahab pattern).
- Switching look keeps the merchant's content (products, text, images, logo); only design changes. Local edits made after a switch show as overrides with reset, and a switch asks before discarding design overrides.
- Output per look: a design brief (scene sentence, colour strategy, token table, type pair AR+Latin, the bold idea, section mix, motion).
- The scenario matrix runs per **look** (12 + Dahab), not per template.
- Known fix before build: the Qamar C hero photo has garbled "ZAS" text; regenerate.

## Phase S — one system contract (templates ↔ editor)
1. **Token contract:** every template = a token set over the SAME roles (page, surface, ink, muted, primary, accent, line, on-primary) + type pair + radius scale + density + image ratio + motion profile. The editor's "style dials" edit these roles, never raw CSS, so any restyle stays coherent and AA-checked live.
2. **Section registry (Plasmic-style):** each section declares props, slots, variants (per template), per-breakpoint overrides and bilingual fields; templates contribute *variants* of shared sections, not forks of commerce logic (Dahab pattern: `ProductDetailClient` owns commerce, skins render).
3. **Content mode vs Design mode (Webstudio-style):** merchants default to content editing (text, images, products, links); design dials sit behind a Design tab; every override shows inherited-vs-local and has reset.
4. **Live contrast + 12px guard in the editor:** a colour pick that breaks AA is flagged with the nearest passing value.

## Phase B — build (one template at a time, Sonnet agents, Opus review)
Per template, like Dahab: `apps/web/src/templates/<id>/` skin, `TEMPLATE_THEMES` + `TEMPLATE_LAYOUT_BASELINES`, onboarding option, section variants, `docs/ebda/templates/<id>.md`, contrast unit test, demo store seed (`scripts/<id>-demo/`) with a real-looking Egyptian catalogue (photos generated in-palette, labelled illustrative).

## Phase E — editor pass
Critique the current editor (impeccable critique + design-critique + apple-design + emil-design-eng) and fix to the bar: direct manipulation on canvas, instant feedback, undo/redo everywhere, autosave state always visible, device preview, phone-usable editor, keyboard paths, Arabic-first labels, no dead ends.

## Scenario matrix (every template)
Empty store · 1 product · 500 products · products with no image · very long Arabic and English names · variants (size/colour) · out of stock / backorder · sale prices · COD-only vs card · RTL and LTR · Arabic-Indic numerals on · slow 3G · reduced motion · zoom 200% · keyboard only · screen reader landmarks · custom logo (wide, tall, missing) · merchant-chosen colours at the extremes · cart/checkout/PDP/PLP/search/account/404/order tracking pages.

## Review loop
impeccable `critique` → `audit` → `polish` per template; `accessibility-review`; `design-critique`; visual diff baselines; Ahmad live review (2–4 rounds budgeted per CLAUDE.md rule 10).

## Then
Delete the FWB skins (`modern/classic/minimal/bold/elegant`) + enum migration + the 8-render-path rule update in CLAUDE.md, once every store is on an Ebda template.
