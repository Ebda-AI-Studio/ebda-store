# Brand Engine — Phase 2: per-template branded baseline (design spec)

**Date:** 2026-06-05
**Status:** Design — approved (pending spec review)
**Author:** Ahmad + Claude (brainstormed)
**Builds on:** Phase 1 (`deriveBrandRoles` — contrast-safe color engine, merged PR #61) and the 2026-06-05 mechanical-ratio UI audit.

## 1. Problem & goal

After Phase 1, **colors** are brand-driven and contrast-safe for every store. But **layout** is not yet brand-ready:

- The packaged `DEFAULT_LAYOUT_SETTINGS` is bare (structural toggles only). The polish that makes wadyaljuz look finished lives in **its own saved `layoutSettings`** — a new store with `layoutSettings = {}` inherits nothing polished.
- The baseline is **template-agnostic**: every template resolves to the same bare default. `TEMPLATE_PRESETS` encodes per-template identity (frame seeds + palette seeds) but only pre-fills the Smart Palette modal — it is never applied as a store's baseline.

**Goal:** every new store and every demo renders **polished and on-brand from creation, with its template's own layout identity**, and **zero per-store setup**:

1. **Colors come from branding** — every baseline is fully tokenized (`token:primary/secondary/accent/card` only, no hardcoded colors). The Phase-1 engine paints them contrast-safe. Change branding → the whole store (and demo) recolors.
2. **Layout is per-template** — each of the 5 templates ships its own polished baseline (sizes, ratios, frames, columns, density, image aspect, section rhythm).
3. **Consistent within, distinct across** — every value in a template's baseline derives from the **shared scale system** (so nothing inside a template is a random one-off), but each template carries **its own scale parameters** so templates are proportionally distinct. This is how the real market (Shopify/Wix/Squarespace/Salla) differentiates themes: shared _method_, per-theme _numbers_.

### Success criteria

1. A brand-new store (only brand colors + template chosen, `layoutSettings = {}`) renders as polished as wadyaljuz, in that template's identity.
2. Each of the 5 templates reads visibly distinct in proportion, yet internally consistent.
3. **wadyaljuz (elegant) is not changed at all** — it has a full saved layout that wins the merge. **palora (minimal) has an EMPTY layout and intentionally adopts the polished minimal baseline** as an upgrade (Ahmad's call, 2026-06-05): it is uncustomized, so inheriting the baseline only improves it. Only wadyaljuz is pinned.
4. Demos showcase all 5 template identities under one brand palette (wadyaljuz's branding).
5. The page builder still overrides anything.

### Non-goals

- Not rewriting the core type-scale helper (`getProductCardTextSizes`) or the structural template components. Per-template "numbers" are expressed through the **existing** layout-settings knobs the platform already has.
- Not a theme marketplace or arbitrary CSS.
- Not removing any page-builder control.

## 2. Foundations already shipped (build on, don't replace)

- **Color engine (Phase 1):** `deriveBrandRoles(theme)` → contrast-safe `--*` vars, wired into the shared `themeToCssVars` (SSR + client + UI).
- **The mechanical scale system (the shared _method_):** `getProductCardTextSizes(cardSize)` + `TYPOGRAPHY_ZONES` + `design.md` (1.25-family modular type scale, 16px floor, 8pt spacing, `tabular-nums`, one container). This is the shared generator that guarantees within-template consistency.
- **The layout knobs (the per-template _numbers_ dials):** `StoreLayoutSettings` already exposes everything a per-template identity needs — `cardSize` (xxs…xl), `pageDensity` (compact/normal/spacious), `pageTextScale` (sm/normal/lg/xl), `cardFrameWidth` (thin/normal/thick/xthick), `cardFrameSize` (compact/normal/comfortable/spacious), `desktopColumns`/`mobileColumns`, `cardAspect`, `cardGap`, per-section typography overrides, `backgroundPreset` rhythm.

Phase 2 = **select these knobs per template, tokenize the colors, and inherit by template** — no core-helper rewrite.

## 3. The scale model (the decision)

**Shared system, per-template numbers.** The _generator_ is the existing mechanical scale (§2). Each template carries its **own parameters** — a small, declarative identity set — and the baseline for that template is that identity rendered against the shared scale.

Mapping the abstract "base size + ratio" onto the platform's real dials:

- **base size** ≈ `pageTextScale` (+ `cardSize` for product cards)
- **ratio / rhythm** is baked into `getProductCardTextSizes` + `TYPOGRAPHY_ZONES` (shared, so internally consistent)
- **density** ≈ `pageDensity` + `cardGap` + `cardFrameSize`
- **weight/identity** ≈ `cardFrameWidth`, `desktopColumns`/`mobileColumns`, `cardAspect`, background rhythm, font flavor (already per-template in component code)

### Per-template parameter table (the identities)

| Template                | textScale | cardSize | density  | frameWidth | frameSize   | desktop cols | aspect   | rhythm      |
| ----------------------- | --------- | -------- | -------- | ---------- | ----------- | ------------ | -------- | ----------- |
| **elegant** (wadyaljuz) | normal    | sm       | normal   | thin       | comfortable | 3            | square   | alternating |
| **modern**              | normal    | sm       | spacious | normal     | normal      | 4            | square   | alternating |
| **classic**             | lg        | md       | normal   | thin       | normal      | 3            | portrait | triad       |
| **minimal**             | normal    | sm       | spacious | thin       | spacious    | 3            | square   | single-bg   |
| **bold**                | lg        | lg       | compact  | thick      | compact     | 2            | square   | monochrome  |

> The **elegant** row is calibrated to reproduce wadyaljuz's _current_ rendering exactly (see §5). The other four are new identities, each internally consistent because every value lands on the shared scale. These are starting values — live-review iteration (per FWB rule 10) is expected; the table is the seed, not the final word.

Colors in every baseline are `token:*` only.

## 4. Architecture (isolated, testable units)

| Unit                                        | File                                                                            | Purpose                                                                                                              | Depends on                       |
| ------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `TEMPLATE_LAYOUT_BASELINES`                 | `packages/shared/src/types/template-baselines.ts`                               | `Record<TemplateId, StoreLayoutSettings>` — 5 tokenized, ratio-consistent baselines                                  | store-layout types, color tokens |
| `getTemplateBaseline(templateId)`           | same file                                                                       | safe lookup → baseline, falls back to the bare `DEFAULT_LAYOUT_SETTINGS` for unknown id                              | TEMPLATE_LAYOUT_BASELINES        |
| `resolveLayoutSettings(input, templateId?)` | `packages/shared/src/types/store-layout.ts` (extend)                            | merge saved layout over the **template** baseline; omit `templateId` → today's global-default behavior (back-compat) | getTemplateBaseline              |
| API layout routes (thread templateId)       | `apps/api/src/routes/public-store-layout.routes.ts`, `store-layout.routes.ts`   | pass `store.template` into the resolver (they already load the store)                                                | resolveLayoutSettings            |
| immutability gate                           | `packages/database/scripts/verify-baseline-nodrift.mjs`                         | read-only: resolved layout for wadyaljuz + palora is byte-identical before/after                                     | resolveLayoutSettings            |
| demo (re)create                             | `packages/database/scripts/seed-template-demos.ts` (extend existing clone flow) | one demo per template: wadyaljuz brand colors + `layoutSettings = {}`                                                | clone-demo-stores pattern        |

**`elegant` baseline source:** extract wadyaljuz's real saved `layoutSettings` (11 keys: hero, footer, sizing, categories, trustStrip, bestSellers, newArrivals, testimonials, filterSidebar, reviewSection, productCardDefaults), replace every hardcoded color with the matching `token:*`, and store as the `elegant` entry. Because wadyaljuz keeps its own saved layout, this baseline only ever applies to _other_ elegant stores.

## 5. Hard constraint — wadyaljuz AND palora never change

Two real active stores have saved `layoutSettings`: **wadyaljuz** (elegant) and **palora** (minimal). Both are golden references.

1. **Merge precedence preserves them:** `resolveLayoutSettings` merges a store's saved values _over_ its template baseline, so any key the store set explicitly wins. wadyaljuz and palora both have full saved layouts → their resolved output is unchanged regardless of the new baselines.
2. **Verification gate (`verify-baseline-nodrift.mjs`):** for **wadyaljuz only**, assert `resolveLayoutSettings(saved, 'elegant')` deep-equals `resolveLayoutSettings(saved)` (today's behavior) for every key, AND the Phase-1 CSS-var no-drift still holds. Any difference = fail; do not ship. Run against live prod data (`railway run` / prod `DATABASE_URL`), read-only. **palora is intentionally NOT pinned** (it has an empty layout and adopts the minimal baseline as an upgrade — success criterion 3); the gate logs palora's before/after for visibility but does not fail on its change.
3. **Elegant calibration:** the `elegant` baseline is derived _from_ wadyaljuz, so even a _new_ elegant store inherits wadyaljuz's exact proportions (tokenized). The minimal baseline is calibrated so a _new_ minimal store (and palora) is polished and on-brand.

## 6. Demos — showcase all 5 identities under one brand

The per-template demo stores referenced in earlier memory are **not in the current DB** (cleaned up after load testing). Phase 2 **(re)creates** them via `seed-template-demos.ts` (extending the existing `clone-demo-stores.ts` pattern):

- One demo per template (modern/elegant/classic/minimal/bold), slug `demo-<template>`.
- Each demo's `theme` = **wadyaljuz's brand colors** (so the Phase-1 engine drives identical, contrast-safe roles across all demos).
- Each demo's `layoutSettings = {}` → inherits **its own template's** baseline.
- Same catalog content per demo (categories + products + images) so the only variable a viewer sees is **template identity**, all under one palette.
- Idempotent read-modify-write, prod via `railway run`, before/after log, never echo `DATABASE_URL`.
- Accessed with no DNS at `<platform-domain>/demo-<template>` (middleware resolves store by first path segment).

Result: 5 demo URLs, one brand palette, five distinct template identities — the customizability pitch made visible.

## 7. Customization freedom (unchanged)

- Baselines are **defaults only**; every value is overridable in the page builder, and explicit overrides win (precedence preserved).
- **Square/compact product image stays the _default_, never a lock** — `cardAspect` / `productDetailPage.imageAspect` remain page-builder knobs (a fashion client flips to portrait). Honors the "expose the knob, don't pre-decide" rule.

## 8. Testing

- **Unit (`template-baselines.test.ts`):** for each of the 5 baselines — (a) it is a valid `StoreLayoutSettings`; (b) it contains **no hardcoded color** (every color value starts with `token:`); (c) `getTemplateBaseline(id)` returns it; (d) unknown id falls back to `DEFAULT_LAYOUT_SETTINGS`.
- **Resolver (`store-layout` tests, extend):** `resolveLayoutSettings({}, 'bold')` returns the bold baseline; `resolveLayoutSettings(saved, 'bold')` lets `saved` win per key; `resolveLayoutSettings({})` (no templateId) returns today's global default unchanged (back-compat).
- **Calibration / immutability:** `verify-baseline-nodrift.mjs` — wadyaljuz resolved layout byte-identical before/after, against live data (palora logged but not gated).
- **Visual:** the 5 demos render distinct per template, all on-brand, legible; square/compact default holds; page-builder override still wins.

## 9. Risks & mitigations

- **wadyaljuz/palora drift** (highest priority) → merge-precedence + the read-only before/after gate (§5). Pinned by their saved layouts.
- **A new template baseline looks off for some catalog** → it's a default, not a lock; knobs stay; live-review iteration budgeted (FWB rule 10).
- **Resolver signature change ripples** → `templateId` is optional; the ~12 existing callers compile and behave unchanged until updated; only the API layout routes (which have `store.template`) are updated this pass.
- **Demo prod writes** → idempotent read-modify-write, before/after log, staging dry-run if available.
- **Tokenization misses a color** → unit test (b) fails the build if any baseline value isn't `token:*`.

## 10. Rollout

Packaged per-template default: `TEMPLATE_LAYOUT_BASELINES` ships in `@force/shared`; new stores + the 5 demos inherit by template. wadyaljuz + palora keep their own saved data. Single merge to main → Vercel storefront + Railway API deploy; demo seed runs once via `railway run`.

## 11. Open decisions (resolved in brainstorm)

- **Scale model:** shared _system_ (existing mechanical scale), per-template _numbers_ (each baseline's own knobs). NOT one shared set of numbers.
- **Baseline sourcing:** shared structural base + per-template identity table; `elegant` derived from wadyaljuz (tokenized).
- **Phase 2 scope:** all 5 template baselines + the mechanism + (re)create all demos, end-to-end.
- **Demos:** brand colors from the **main store's branding** (wadyaljuz), per-template layout identity; one demo per template.
- **Immutability:** wadyaljuz **and** palora pinned by saved layouts + read-only before/after gate.
- **Product image:** square/compact **default**, overridable knob (never locked).
