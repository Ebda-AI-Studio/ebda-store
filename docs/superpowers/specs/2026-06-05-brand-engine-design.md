# Brand Engine — brand-driven storefront baseline (design spec)

**Date:** 2026-06-05
**Status:** Design — pending review
**Author:** Ahmad + Claude (brainstormed)

## 1. Problem & goal

Today a polished, consistent storefront (the wadyaljuz look) requires **per-store manual work**: hand-set colors, frame settings, sizes in each store's `layoutSettings`, plus one-off DB tweaks (e.g. flipping wadyaljuz's category frame color from `token:card`→`token:primary`). The default templates' own color choices are mediocre.

**Goal:** make the **client's brand identity drive the entire storefront automatically**. A client gives **brand colors + a few typography knobs + a logo** in Settings → Brand, and _every_ page (home, categories, PLP, PDP, checkout, every section) renders with the same polished, consistent application of colors / sizes / framing — with **zero per-page or per-store manual setup**. The page builder remains for any further customization. Brand in → polished, on-brand store out.

### Success criteria

1. A brand-new store with only brand colors + logo set renders as polished and consistent as wadyaljuz is today.
2. Changing one brand color re-themes the whole store coherently and **readably** (any brand, light or dark).
3. **wadyaljuz is not changed at all** (pixel-identical before/after).
4. Demo stores can be reset to literally match wadyaljuz.
5. The page builder still overrides anything (both suites coexist).

### Non-goals

- Not redesigning the templates' structure/layout (the audit already standardized the mechanical system).
- Not a theme marketplace or arbitrary CSS editing.
- Not removing any existing page-builder control.

## 2. The mechanical model (foundation — already shipped)

The storefront is a **token-driven design system** (built by the 2026-06-05 UI audit):

- **Colors:** `token:<name>` → `resolveColor` → `hsl(var(--<name>))`. Brand colors already feed `--primary/--secondary/--accent/--card/--foreground/--muted/--border` per store via the per-store CSS emitter.
- **Contrast/inversion:** `pickReadableForeground(bg)` (WCAG flip @0.179) + `contrastRatio` guarantee legible foregrounds on any surface.
- **Type scale:** `getProductCardTextSizes(cardSize)` + `TYPOGRAPHY_ZONES` + `design.md` — one scale, themes supply flavor only.
- **Corrected components (universal, every store):** section-heading auto-invert, filter primary-fill + invert, PDP name≥price, theme cards routed through the type scale, **`BottomTabBar` portaled to `<body>`** (fixed-position fix), **responsive PDP gallery cap**.

The Brand Engine builds **on top of** this — it does not replace it. The corrected components above are the baseline rendering and must not regress.

## 3. Inputs — the Brand settings panel

The brand palette **already exists** on `StoreTheme` (`packages/shared/src/types/store-theme.ts`): `primaryColor, secondaryColor, accentColor, cardColor, foregroundColor, mutedColor, borderColor`. No new color fields.

**Brand inputs that drive the whole store:**

- **Colors:** primary, secondary, accent, card (+ the existing neutrals).
- **Typography (3 knobs):** heading font family, body font family, base-size scale (one proportional dial: compact / normal / spacious — scales the whole type scale, ratios intact).
- **Logo** (already per-store).

The heading "flavor" (weight/tracking/uppercase) stays part of the **template** choice, not a brand knob, to keep the panel small.

## 4. The Brand Engine — `deriveBrandRoles(theme)`

A **pure, unit-tested** function (`packages/shared/src/utils/brand-roles.ts`) that maps the palette → **UI roles**, smart-auto by luminance/saturation, contrast-checked.

**Roles (what the storefront paints):**

- `accentRole` — card frames, filter fills, badges, CTAs, active states, the elevated mobile-bar cart pill. Default source: the **most-saturated sufficiently-dark** brand color (wadyaljuz: maroon).
- `surfaceRole` — card/page surfaces. Default source: the **lightest** brand color (wadyaljuz: card/white).
- `secondaryRole` — secondary spots (e.g. the mobile bottom-bar background tint, secondary buttons). Default source: a **mid** brand color (secondary/accent).
- For each role, the **foreground** is `pickReadableForeground(resolvedRoleBg)` so text/icons are always legible — this is what makes _any_ brand work, light or dark.

**Output:** the CSS custom-property values the storefront already consumes (`--primary` etc.) + any new role vars, emitted by the existing per-store CSS emitter. Reuses `generateSectionPalette` / `lightenColor` for tints.

**Contract:** `deriveBrandRoles(theme) → { cssVars: Record<string,string>, roles: {...} }`. Deterministic, no side effects. Tested for: dark brand, light brand, low-contrast palette (must still produce legible roles), single-color palette.

## 5. The Branded Baseline — packaged `DEFAULT_LAYOUT_SETTINGS`

Extract wadyaljuz's polished `layoutSettings`, **replace hardcoded colors with role tokens** (`token:primary` etc.), and ship it as the packaged default. A store with no explicit overrides inherits it → polished + branded with zero setup.

**Image sizing in the baseline (the "square/compact" decision):**

- **Default** product image = **square 1:1, compact** (suits the Kuwait grocery/goods market; wadyaljuz proves it). Uses the existing `productSquare` standard + `cardAspect:'square'` default.
- **Customizable, never locked:** the aspect stays a page-builder knob (`cardAspect` / `productDetailPage.imageAspect` — square/portrait/landscape/wide). A fashion client flips to portrait. This honors the "expose the knob, don't pre-decide" rule.
- Mobile responsive caps (the PDP gallery cap) are universal code, independent of aspect.

## 6. Customization freedom (both suites)

- The baseline is **defaults only** — every value is overridable in the page builder (colors per zone, frame, aspect, sizes, typography per zone).
- Explicit overrides in `layoutSettings`/zones **win** over the baseline (current precedence preserved).
- Result: branded-by-default + fully customizable.

## 7. Hard constraint — wadyaljuz is never changed

wadyaljuz is the **golden reference** and is pinned by its own explicit `theme` + `layoutSettings` (untouched). Two guarantees:

1. The engine must compute **identical** CSS vars for wadyaljuz's palette as today — calibrate the role-derivation rules so `deriveBrandRoles(wadyaljuz.theme)` reproduces its current `--primary/--card/...` exactly.
2. **Verification gate:** snapshot wadyaljuz's computed CSS vars + a set of storefront screenshots **before**, and assert **after == before**. If anything differs, the engine is wrong — wadyaljuz does not move.

## 8. Demo reset → literally identical to wadyaljuz

For each demo store: set `demo.theme = wadyaljuz.theme` (palette + typography) and `demo.layoutSettings = {}` (inherit the branded baseline). Since the baseline faithfully reproduces wadyaljuz's layout, the demo renders identical to wadyaljuz. One-off, idempotent script (`railway run`, prod, read-modify-write per store, before/after log; never echo `DATABASE_URL`).

## 9. Architecture (isolated, testable units)

| Unit                      | File                                                             | Purpose                                   | Depends on          |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------- | ------------------- |
| `deriveBrandRoles`        | `packages/shared/src/utils/brand-roles.ts`                       | palette → roles + CSS vars (pure)         | color.ts helpers    |
| brand CSS emit            | extend the per-store emitter (`emit-zone-css.ts` / StoreContext) | apply derived vars                        | deriveBrandRoles    |
| `DEFAULT_LAYOUT_SETTINGS` | `packages/shared/src/types/store-layout.ts`                      | tokenized branded baseline                | role tokens         |
| Brand settings UI         | `apps/admin/.../branding`                                        | the inputs (colors + 3 typo knobs + logo) | existing ColorField |
| demo-reset script         | `packages/database/scripts/reset-demos-to-baseline.ts`           | clone wadyaljuz to demos                  | —                   |

## 10. Testing

- **Unit:** `deriveBrandRoles` — dark/light/low-contrast/single-color palettes; assert legible role foregrounds (contrast ≥ threshold) and stable role assignment.
- **Calibration:** `deriveBrandRoles(wadyaljuz.theme)` === wadyaljuz's current vars (golden snapshot test).
- **Visual gate:** wadyaljuz computed-CSS + screenshot diff before/after = identical (manual + scripted).
- **Demo verification:** after reset, demo storefront screenshots match wadyaljuz.
- **Integration:** page-builder override still beats the baseline.

## 11. Risks & mitigations

- **wadyaljuz drift** (engine changes its CSS) → calibrate-to-reference + before/after verification gate (§7). Highest priority.
- **Light/odd brand colors** produce poor auto-roles → contrast-checked derivation (`pickReadableForeground` on every role) + unit tests for edge palettes; page-builder override as escape hatch.
- **Square default wrong for some catalogs** → it's a default, not a lock; aspect knob stays (§5/§6).
- **Demo prod writes** → idempotent read-modify-write script, before/after log, staging dry-run first if available.

## 12. Rollout

Packaged default (chosen): `DEFAULT_LAYOUT_SETTINGS` = branded baseline → new stores + reset demos inherit it; future clients free. wadyaljuz keeps its own data.

## 13. Open decisions (resolved in brainstorm)

- Mapping mechanism: **smart-auto + page-builder override**.
- Brand inputs: primary/secondary/accent/card + heading font + body font + base-size scale + logo.
- Demos: **literally identical to wadyaljuz** (clone theme + inherit baseline).
- Rollout: **packaged default**.
- Product image: **square/compact default, overridable knob** (never locked).
