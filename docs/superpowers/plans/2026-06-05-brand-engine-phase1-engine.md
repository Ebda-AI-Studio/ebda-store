# Brand Engine — Phase 1: contrast-safe role engine (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the keystone of the Brand Engine — a pure `deriveBrandRoles(theme)` that emits the storefront CSS vars with **contrast-guaranteed foregrounds** (stored value wins → wadyaljuz unchanged; missing/unreadable → derived via `pickReadableForeground`), and wire it into the per-store CSS emitter.

**Architecture:** A pure function in `@force/shared` consumes a `StoreTheme` and returns the `--*` CSS-var map. The web app's `themeToCssVars` (in `StoreContext`) delegates to it. Stored foregrounds are preserved verbatim (so wadyaljuz is pixel-identical); only _missing_ foregrounds are derived for contrast. This is the safe foundation; later plans add the baseline config, demo reset, and admin UI (and, if approved after visual review, luminance-based role reassignment).

**Tech Stack:** TypeScript, `@force/shared` (`resolveColor`, `pickReadableForeground`, `contrastRatio`), vitest. The spec lives at `docs/superpowers/specs/2026-06-05-brand-engine-design.md` (§3, §4, §7).

**Scope note:** This is Phase 1 of a multi-plan feature. Phase 1 = the engine + emitter integration. It is independently shippable and de-risks the hard constraint (wadyaljuz must not move). Subsequent plans: baseline `DEFAULT_LAYOUT_SETTINGS`, demo reset, admin Brand UI, optional luminance role reassignment.

---

## File structure

- **Create** `packages/shared/src/utils/brand-roles.ts` — `deriveBrandRoles(theme): Record<string,string>` (pure). One responsibility: theme → CSS-var map with contrast-safe foregrounds.
- **Create** `packages/shared/src/utils/__tests__/brand-roles.test.ts` — unit tests.
- **Modify** `packages/shared/src/utils/index.ts` — export `deriveBrandRoles`.
- **Modify** `apps/web/src/contexts/StoreContext.tsx:22-54` — `themeToCssVars` delegates to `deriveBrandRoles` for the color/foreground pairs.

---

## Task 1: `deriveBrandRoles` — contrast-safe foreground derivation

**Files:**

- Create: `packages/shared/src/utils/brand-roles.ts`
- Test: `packages/shared/src/utils/__tests__/brand-roles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { deriveBrandRoles } from '../brand-roles';
import type { StoreTheme } from '../../types/store-theme';

// Minimal theme factory — only the fields deriveBrandRoles reads.
const theme = (over: Partial<StoreTheme> = {}): StoreTheme =>
  ({
    primaryColor: '348 68% 25%', // wadyaljuz maroon (dark)
    primaryForeground: '0 0% 100%',
    secondaryColor: '220 14% 96%',
    secondaryForeground: '220 9% 20%',
    accentColor: '24 100% 50%',
    accentForeground: '0 0% 100%',
    cardColor: '0 0% 100%', // white
    cardForeground: '0 0% 10%',
    foregroundColor: '0 0% 10%',
    mutedColor: '220 14% 96%',
    mutedForeground: '220 9% 46%',
    borderColor: '220 13% 91%',
  }) as StoreTheme;

describe('deriveBrandRoles', () => {
  it('preserves a stored foreground verbatim (wadyaljuz-immutability)', () => {
    const vars = deriveBrandRoles(theme());
    expect(vars['--primary']).toBe('348 68% 25%');
    expect(vars['--primary-foreground']).toBe('0 0% 100%'); // stored value, untouched
    expect(vars['--card']).toBe('0 0% 100%');
    expect(vars['--card-foreground']).toBe('0 0% 10%');
  });

  it('derives a readable foreground when none is stored', () => {
    // A new store set only a light card color, no card-foreground.
    const vars = deriveBrandRoles(
      theme({ cardColor: '0 0% 100%', cardForeground: undefined as unknown as string })
    );
    // pickReadableForeground(white) → black; emitted as an hsl-triple our CSS expects.
    expect(vars['--card-foreground']).toBe('0 0% 0%');
  });

  it('derives a readable foreground when the stored one is unreadable on its surface', () => {
    // Stored white foreground on a white card = invisible. Engine overrides to readable.
    const vars = deriveBrandRoles(theme({ cardColor: '0 0% 100%', cardForeground: '0 0% 100%' }));
    expect(vars['--card-foreground']).toBe('0 0% 0%'); // forced to black (was unreadable white)
  });

  it('keeps a deliberate readable foreground (does not over-correct)', () => {
    // Maroon bg + white text reads fine (≈AA) → keep the stored white.
    const vars = deriveBrandRoles(
      theme({ primaryColor: '348 68% 25%', primaryForeground: '0 0% 100%' })
    );
    expect(vars['--primary-foreground']).toBe('0 0% 100%');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/utils/__tests__/brand-roles.test.ts`
Expected: FAIL — `deriveBrandRoles` is not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/utils/brand-roles.ts
import type { StoreTheme } from '../types/store-theme';
import { resolveColor, pickReadableForeground, contrastRatio } from './color';

// Roles whose foreground must stay legible against their own surface color.
// Each entry: [colorVar, colorField, foregroundVar, foregroundField].
const PAIRS: ReadonlyArray<[string, keyof StoreTheme, string, keyof StoreTheme]> = [
  ['--primary', 'primaryColor', '--primary-foreground', 'primaryForeground'],
  ['--secondary', 'secondaryColor', '--secondary-foreground', 'secondaryForeground'],
  ['--accent', 'accentColor', '--accent-foreground', 'accentForeground'],
  ['--card', 'cardColor', '--card-foreground', 'cardForeground'],
];

// 2:1 floor matches the storefront SectionHeading guard (2026-06-05): kills
// invisible text (white-on-white = 1:1) while keeping a deliberate brand pick.
const MIN_CONTRAST = 2;

/** Convert a hex/hsl()/triple color to the bare `H S% L%` triple our CSS vars use. */
function toTriple(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // pickReadableForeground returns '#ffffff'/'#000000'; map to the triple form.
  const v = value.trim();
  if (v === '#ffffff' || v.toLowerCase() === '#fff') return '0 0% 100%';
  if (v === '#000000' || v.toLowerCase() === '#000') return '0 0% 0%';
  return v; // already a triple or a wrapped color the emitter handles
}

/**
 * Build the storefront CSS-var map for a theme with GUARANTEED-readable
 * foregrounds. A stored foreground that reads fine against its surface is kept
 * verbatim (so configured stores — wadyaljuz — are unchanged). A missing or
 * unreadable foreground is replaced with pickReadableForeground(surface).
 */
export function deriveBrandRoles(theme: StoreTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [colorVar, colorField, fgVar, fgField] of PAIRS) {
    const color = theme[colorField] as string | undefined;
    if (color) out[colorVar] = color;
    const surface = resolveColor(`token:${colorField.replace('Color', '')}`, theme) ?? toCss(color);
    const stored = theme[fgField] as string | undefined;
    const auto = toTriple(pickReadableForeground(surface)) ?? '0 0% 0%';
    if (!stored) {
      out[fgVar] = auto;
    } else {
      const storedCss = toCss(stored);
      out[fgVar] =
        surface && storedCss && contrastRatio(surface, storedCss) >= MIN_CONTRAST ? stored : auto;
    }
  }
  return out;
}

/** Wrap a bare `H S% L%` triple as an hsl() so contrast/parse helpers accept it. */
function toCss(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v.startsWith('hsl(') || v.startsWith('#') ? v : `hsl(${v})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/src/utils/__tests__/brand-roles.test.ts`
Expected: PASS (4 tests). If `contrastRatio`/`pickReadableForeground` can't parse the `hsl(...)` triple form, fix `toCss`/`toTriple` so the helpers receive a parseable color — do not loosen the assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/brand-roles.ts packages/shared/src/utils/__tests__/brand-roles.test.ts
git commit -m "feat(shared): deriveBrandRoles — contrast-safe storefront foregrounds"
```

---

## Task 2: Export from the package barrel

**Files:**

- Modify: `packages/shared/src/utils/index.ts`

- [ ] **Step 1: Add the export**

Add to `packages/shared/src/utils/index.ts` (next to the `color` exports):

```ts
export { deriveBrandRoles } from './brand-roles';
```

- [ ] **Step 2: Verify it resolves**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/utils/index.ts
git commit -m "feat(shared): export deriveBrandRoles"
```

---

## Task 3: Wire the engine into the storefront CSS emitter

**Files:**

- Modify: `apps/web/src/contexts/StoreContext.tsx:22-54` (`themeToCssVars`)

- [ ] **Step 1: Delegate the 4 color/foreground pairs to the engine**

In `themeToCssVars`, import `deriveBrandRoles` from `@force/shared` and spread its output OVER the existing map, so the primary/secondary/accent/card pairs come from the engine while every other var (background, muted, border, popover, destructive, success, warning, radius, font, bg-page, bg-section-alt) stays exactly as-is:

```ts
import { deriveBrandRoles } from '@force/shared';

function themeToCssVars(theme: StoreTheme): Record<string, string> {
  const bg = resolveBackgroundPreset(theme);
  return {
    // unchanged vars first…
    '--primary': theme.primaryColor,
    '--primary-foreground': theme.primaryForeground,
    '--secondary': theme.secondaryColor,
    '--secondary-foreground': theme.secondaryForeground,
    '--accent': theme.accentColor,
    '--accent-foreground': theme.accentForeground,
    '--background': theme.backgroundColor,
    '--foreground': theme.foregroundColor,
    '--muted': theme.mutedColor,
    '--muted-foreground': theme.mutedForeground,
    '--border': theme.borderColor,
    '--card': theme.cardColor,
    '--card-foreground': theme.cardForeground,
    '--popover': theme.popoverColor,
    '--popover-foreground': theme.popoverForeground,
    '--input': theme.inputColor,
    '--ring': theme.ringColor,
    '--destructive': theme.destructiveColor,
    '--destructive-foreground': theme.destructiveForeground,
    '--success': theme.successColor,
    '--success-foreground': theme.successForeground,
    '--warning': theme.warningColor,
    '--warning-foreground': theme.warningForeground,
    '--radius': BORDER_RADIUS_MAP[theme.borderRadius],
    '--font-family': FONT_FAMILY_MAP[theme.fontFamily],
    '--bg-page': bg.bgPage,
    '--bg-section-alt': bg.bgSectionAlt,
    // …then the engine overrides the 4 brand pairs with contrast-safe values.
    ...deriveBrandRoles(theme),
  };
}
```

- [ ] **Step 2: Typecheck the web app**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: no new errors (the file already imports from `@force/shared`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/contexts/StoreContext.tsx
git commit -m "feat(web): emit contrast-safe brand foregrounds via deriveBrandRoles"
```

---

## Task 4: wadyaljuz-immutability calibration test

**Files:**

- Test: `packages/shared/src/utils/__tests__/brand-roles.test.ts` (extend)

- [ ] **Step 1: Write the calibration test**

Append to the test file. This is the gate from spec §7: a fully-configured theme (all foregrounds stored + readable) must come out byte-identical.

```ts
it('CALIBRATION: a fully-configured theme is returned unchanged (wadyaljuz gate)', () => {
  const wady = theme(); // all *Color + readable *Foreground set
  const vars = deriveBrandRoles(wady);
  expect(vars['--primary']).toBe(wady.primaryColor);
  expect(vars['--primary-foreground']).toBe(wady.primaryForeground);
  expect(vars['--secondary-foreground']).toBe(wady.secondaryForeground);
  expect(vars['--accent-foreground']).toBe(wady.accentForeground);
  expect(vars['--card-foreground']).toBe(wady.cardForeground);
});
```

- [ ] **Step 2: Run and verify it passes**

Run: `npx vitest run packages/shared/src/utils/__tests__/brand-roles.test.ts`
Expected: PASS (5 tests). If the calibration test fails, the engine is over-correcting a readable stored foreground — tighten `MIN_CONTRAST` handling so a stored foreground at/above the floor is kept verbatim. **Never** change the assertion.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/utils/__tests__/brand-roles.test.ts
git commit -m "test(shared): wadyaljuz-immutability calibration for deriveBrandRoles"
```

---

## Task 5: Live verification on wadyaljuz (manual gate)

- [ ] **Step 1:** After Phase-1 deploys, load `https://wadyaljuz.com` + a PDP + categories. Confirm colors/foregrounds are visually identical to before (no regressions). The category headings, filter bar, and PDP must look unchanged — wadyaljuz's foregrounds are all stored, so the engine returns them verbatim.
- [ ] **Step 2:** Spot-check the engine's _new_ behavior by reasoning about a hypothetical new store with only `cardColor: white` and no `cardForeground`: it now resolves to black text instead of inheriting an undefined/invisible value (this is what the unit tests prove).

---

## Self-review

- **Spec coverage:** §4 (deriveBrandRoles, contrast-safe) → Tasks 1–3. §7 (wadyaljuz immutability) → Task 4 + Task 5. §3 (inputs already on StoreTheme) → no migration. Luminance role _reassignment_ + baseline config + demo reset + admin UI are explicitly out of Phase 1 (later plans).
- **Placeholders:** none — all steps have code/commands.
- **Type consistency:** `deriveBrandRoles(theme): Record<string,string>` used identically in Task 1 (definition), Task 2 (export), Task 3 (consumer). Helper names `toTriple`/`toCss` consistent.
