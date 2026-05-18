# Smart Colors + Unified Page Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two related improvements: (1) brand-token + hex color picker that auto-fixes section text contrast at render and warns the merchant in admin, (2) merge the `/layout` + `/typography` admin pages into one unified `/page-builder` URL where each storefront section bundles all its Layout + Typography controls in storefront order.

**Architecture:** Phase 1 adds five pure helpers in `@force/shared` (`resolveColor`, `pickReadableForeground`, `contrastRatio`, `parseColorToRgb`, `relativeLuminance`), updates the Zod schema to accept `'token:<name>'` strings alongside hex, wires storefront sections to set a `--section-fg` CSS custom property the auto-fixed text color cascades into, and rewrites the admin `ColorField` as an extracted component with a brand-token dropdown + hex fallback + `ColorContrastPreview` band. Phase 2 renames the route, extracts a `<ZoneEditor>` from the current typography page, distributes zones under their owning section cards, and ships 301 redirects from the old URLs.

**Tech Stack:** TypeScript, Zod, React (Next.js 16 App Router for `apps/admin` + `apps/web`), Tailwind CSS, Prisma JSONB column (no migration), Vitest for the new color helpers.

**Spec:** `docs/superpowers/specs/2026-05-18-smart-colors-and-page-builder-design.md`

---

## Spec coverage map

| Spec section                                                                               | Tasks                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1.1 `ColorValue` convention + Zod                                                          | Task 1 (new validator), Task 2 (schema updates), Task 12 (4-grep verify)              |
| 1.2 `resolveColor`                                                                         | Task 3 (test) + Task 4 (impl)                                                         |
| 1.3 `pickReadableForeground`                                                               | Task 5 (parsers + test) + Task 6 (impl + test)                                        |
| 1.4 `contrastRatio`                                                                        | Task 7 (test + impl)                                                                  |
| 1.5 Storefront wiring                                                                      | Task 8 (section-bg.ts) + Task 9 (HomePageContent.tsx) + Task 10 (globals.css cascade) |
| 1.6 Admin live preview band                                                                | Task 11 (`ColorContrastPreview` component)                                            |
| 1.7 Admin ColorField revised                                                               | Task 12 (extract + dropdown + preview)                                                |
| Phase 1 acceptance                                                                         | Task 13 (browser-qa visual sweep + commit)                                            |
| 2.1 Route + sidebar                                                                        | Task 14 (rename + redirects)                                                          |
| 2.2 Section card structure                                                                 | Task 15 (skeleton refactor)                                                           |
| 2.3 Zone ownership mapping                                                                 | Task 16 (per-section zone distribution)                                               |
| 2.4 `<ZoneEditor>` extraction                                                              | Task 15 prerequisite                                                                  |
| 2.5 Visual / save details                                                                  | Task 17 (parallel save)                                                               |
| Phase 2 acceptance                                                                         | Task 18 (browser-qa + commit)                                                         |
| 4.1 Why per-section override (spec update)                                                 | Task 15b types + Zod + resolver, Task 15c storefront render, Task 16 admin UI         |
| 4.2 Data model (ZoneOverride + SectionTypographyOverride)                                  | Task 15b                                                                              |
| 4.3 Storefront resolver `resolveSectionZone`                                               | Task 15b Step 4                                                                       |
| 4.4 Render-time priority (auto-fix wins via `!important`)                                  | Task 15c Step 4                                                                       |
| 4.5 Admin per-section editors + Reset link                                                 | Task 16 (updated)                                                                     |
| Smart palette generator (2026-05-19 ahmad: "give colors and set smartly for all sections") | Task 15d (helper + tests) + Task 15e (modal + page-builder button)                    |

---

## File structure

**Phase 1 — Smart colors:**

- **Create**:
  - `packages/shared/src/utils/color.ts` — all five color helpers
  - `packages/shared/src/utils/color.test.ts` — Vitest suite for the helpers
  - `apps/admin/src/components/ColorField.tsx` — extracted from layout/page.tsx, now has brand-token dropdown
  - `apps/admin/src/components/ColorContrastPreview.tsx` — live preview band
- **Modify**:
  - `packages/shared/src/index.ts` — re-export the new helpers
  - `apps/api/src/routes/store-layout.routes.ts` — Zod regex union (hex | token)
  - `apps/web/src/templates/shared/section-bg.ts` — call `resolveColor` + set `--section-fg` via `pickReadableForeground`
  - `apps/web/src/app/HomePageContent.tsx` — pass `theme` into section-bg helper
  - `apps/web/src/app/globals.css` (or layout.tsx CSS) — section-scoped text color cascade
  - `apps/admin/src/app/stores/[id]/layout/page.tsx` — import the new `ColorField` + `ColorContrastPreview` instead of the inline helper; pass `theme` prop

**Phase 2 — Page Builder merge:**

- **Create**:
  - `apps/admin/src/app/stores/[id]/page-builder/page.tsx` — moved from `layout/page.tsx`
  - `apps/admin/src/components/ZoneEditor.tsx` — extracted from typography/page.tsx
- **Modify**:
  - `apps/admin/next.config.ts` (or `redirects()` export in the Next config file) — 301s for old URLs
  - `apps/admin/src/components/AdminLayout.tsx` (or wherever the sidebar is built) — rename "Layout" → "Page Builder", remove "Typography"
  - `apps/admin/src/contexts/LanguageContext.tsx` (translations map) — sidebar labels en + ar
- **Delete**:
  - `apps/admin/src/app/stores/[id]/layout/page.tsx` (after move)
  - `apps/admin/src/app/stores/[id]/typography/page.tsx`

---

# Phase 1 — Smart colors

## Task 1: Token + hex Zod validator

**Files:**

- Modify: `apps/api/src/routes/store-layout.routes.ts:45` (the `hexColor` validator added 2026-05-18)

- [x] **Step 1: Replace `hexColor` with `colorValue`**

In `apps/api/src/routes/store-layout.routes.ts`, find the `hexColor` declaration around line 45:

```ts
// Hex color, 3 or 6 digits, optional alpha. Empty string allowed = unset.
const hexColor = z
  .string()
  .regex(/^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|)$/, 'Must be a hex color')
  .optional();
```

Replace with:

```ts
// Color value: hex (#RGB, #RRGGBB, #RRGGBBAA) OR brand token (token:<name>) OR empty.
// Empty string = unset, falls back to theme background preset.
const colorValue = z
  .string()
  .regex(
    /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|token:(primary|secondary|accent|card|muted|foreground|border)|)$/,
    'Must be a hex color or token:<brand-color>'
  )
  .optional();
```

- [x] **Step 2: Rename every `hexColor` reference in the file to `colorValue`**

Use `grep -n "hexColor" apps/api/src/routes/store-layout.routes.ts` to enumerate. Update each `bgColor: hexColor` and `cardFrameColor: hexColor` to `bgColor: colorValue` / `cardFrameColor: colorValue`.

- [x] **Step 3: Verify** with `grep -c "hexColor\|colorValue" apps/api/src/routes/store-layout.routes.ts` — `hexColor` count = 0, `colorValue` count ≥ 7 (one declaration + at least 6 uses across bg + frame fields).

- [x] **Step 4: Commit**

```bash
git add apps/api/src/routes/store-layout.routes.ts
git commit -m "feat(api): zod colorvalue accepts hex or token:<brand-color>"
```

---

## Task 2: Color helpers — failing tests first

**Files:**

- Create: `packages/shared/src/utils/color.test.ts`

- [ ] **Step 1: Write the failing test suite**

```ts
// packages/shared/src/utils/color.test.ts
import { describe, it, expect } from 'vitest';
import { resolveColor, pickReadableForeground, contrastRatio, parseColorToRgb } from './color';
import type { StoreTheme } from '../types/store-theme';

const TEST_THEME = {
  primary: '24 100% 50%', // brand orange ~#FF6E00
  secondary: '220 13% 91%',
  accent: '210 80% 60%',
  card: '0 0% 100%', // white
  muted: '210 16% 96%',
  foreground: '224 71% 4%', // near-black
  border: '220 13% 91%',
  background: '0 0% 100%',
} as unknown as StoreTheme;

describe('parseColorToRgb', () => {
  it('parses #RRGGBB', () => {
    expect(parseColorToRgb('#FF6E00')).toEqual({ r: 255, g: 110, b: 0 });
  });

  it('parses #RGB shorthand', () => {
    expect(parseColorToRgb('#F00')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('parses hsl(H S% L%) space-separated', () => {
    expect(parseColorToRgb('hsl(0 100% 50%)')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('parses bare HSL triplet "H S% L%"', () => {
    expect(parseColorToRgb('0 100% 50%')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('returns null for invalid input', () => {
    expect(parseColorToRgb('not-a-color')).toBeNull();
    expect(parseColorToRgb('')).toBeNull();
  });
});

describe('resolveColor', () => {
  it('returns undefined for empty input', () => {
    expect(resolveColor(undefined, TEST_THEME)).toBeUndefined();
    expect(resolveColor('', TEST_THEME)).toBeUndefined();
  });

  it('passes through raw hex unchanged', () => {
    expect(resolveColor('#FF6E00', TEST_THEME)).toBe('#FF6E00');
  });

  it('resolves token:<name> to hsl() string', () => {
    expect(resolveColor('token:primary', TEST_THEME)).toBe('hsl(24 100% 50%)');
  });

  it('returns undefined for unknown token', () => {
    expect(resolveColor('token:nonexistent' as string, TEST_THEME)).toBeUndefined();
  });

  it('passes through HSL string from theme if already wrapped', () => {
    const themeWithWrappedHsl = { ...TEST_THEME, primary: 'hsl(24 100% 50%)' } as StoreTheme;
    expect(resolveColor('token:primary', themeWithWrappedHsl)).toBe('hsl(24 100% 50%)');
  });
});

describe('pickReadableForeground', () => {
  it('returns black for bright bg', () => {
    expect(pickReadableForeground('#FFFFFF')).toBe('#000000');
    expect(pickReadableForeground('#FFFF00')).toBe('#000000'); // yellow
  });

  it('returns white for dark bg', () => {
    expect(pickReadableForeground('#000000')).toBe('#ffffff');
    expect(pickReadableForeground('#1a1a1a')).toBe('#ffffff');
  });

  it('returns white for the FWB brand orange', () => {
    // #FF6E00 has luminance ~0.30 — should pick white text
    expect(pickReadableForeground('#FF6E00')).toBe('#ffffff');
  });

  it('handles hsl() input', () => {
    expect(pickReadableForeground('hsl(0 0% 100%)')).toBe('#000000');
    expect(pickReadableForeground('hsl(0 0% 0%)')).toBe('#ffffff');
  });

  it('returns undefined for unparseable input', () => {
    expect(pickReadableForeground(undefined)).toBeUndefined();
    expect(pickReadableForeground('not-a-color')).toBeUndefined();
  });
});

describe('contrastRatio', () => {
  it('returns 21 for black vs white', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });

  it('returns 1 for identical colors', () => {
    expect(contrastRatio('#FF6E00', '#FF6E00')).toBeCloseTo(1, 1);
  });

  it('passes WCAG AA for the FWB orange + white text', () => {
    const ratio = contrastRatio('#FF6E00', '#FFFFFF');
    // FWB orange + white is ~3.0:1 — passes AA large text (3.0) but fails AA normal text (4.5).
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(4.5);
  });

  it('returns NaN-safe value when an input is unparseable', () => {
    expect(contrastRatio('not-a-color', '#FFFFFF')).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test — expect every test to FAIL** (no `color.ts` yet)

```bash
cd /Users/ahmadsharaf/Desktop/projects/force-website-builder
npx vitest run packages/shared/src/utils/color.test.ts 2>&1 | tail -10
```

Expected: every test fails with "Cannot find module './color'" or similar.

---

## Task 3: Implement `parseColorToRgb` + `relativeLuminance`

**Files:**

- Create: `packages/shared/src/utils/color.ts`

- [ ] **Step 1: Write the parsing helpers**

```ts
// packages/shared/src/utils/color.ts

export interface Rgb {
  r: number; // 0-255
  g: number;
  b: number;
}

/**
 * Parse a color string to RGB. Handles:
 *   - '#RRGGBB' / '#RGB' / '#RRGGBBAA'
 *   - 'hsl(H S% L%)' / 'hsl(H, S%, L%)'
 *   - bare HSL triplet 'H S% L%' (Tailwind/shadcn convention used by StoreTheme)
 * Returns null for unparseable input.
 */
export function parseColorToRgb(input: string | undefined): Rgb | null {
  if (!input) return null;
  const trimmed = input.trim();

  // Hex
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    return null;
  }

  // hsl(...) wrapper
  const hslMatch =
    trimmed.match(
      /^hsl\(\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)%\s*[, ]\s*(-?\d+(?:\.\d+)?)%\s*\)$/i
    ) ||
    trimmed.match(/^hsl\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%\s*\)$/i);

  if (hslMatch) {
    return hslToRgb(parseFloat(hslMatch[1]), parseFloat(hslMatch[2]), parseFloat(hslMatch[3]));
  }

  // Bare triplet "H S% L%" (Tailwind shadcn convention)
  const tripletMatch = trimmed.match(
    /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%$/
  );
  if (tripletMatch) {
    return hslToRgb(
      parseFloat(tripletMatch[1]),
      parseFloat(tripletMatch[2]),
      parseFloat(tripletMatch[3])
    );
  }

  return null;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const sNorm = Math.max(0, Math.min(100, s)) / 100;
  const lNorm = Math.max(0, Math.min(100, l)) / 100;
  const hNorm = (((h % 360) + 360) % 360) / 360;

  if (sNorm === 0) {
    const v = Math.round(lNorm * 255);
    return { r: v, g: v, b: v };
  }

  const q = lNorm < 0.5 ? lNorm * (1 + sNorm) : lNorm + sNorm - lNorm * sNorm;
  const p = 2 * lNorm - q;

  const hueToRgb = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  return {
    r: Math.round(hueToRgb(hNorm + 1 / 3) * 255),
    g: Math.round(hueToRgb(hNorm) * 255),
    b: Math.round(hueToRgb(hNorm - 1 / 3) * 255),
  };
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 * Formula: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(rgb: Rgb): number {
  const norm = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * norm(rgb.r) + 0.7152 * norm(rgb.g) + 0.0722 * norm(rgb.b);
}
```

- [ ] **Step 2: Run the parser tests**

```bash
npx vitest run packages/shared/src/utils/color.test.ts -t "parseColorToRgb" 2>&1 | tail -10
```

Expected: all 5 `parseColorToRgb` tests PASS. Other tests still fail.

---

## Task 4: Implement `resolveColor`

**Files:**

- Modify: `packages/shared/src/utils/color.ts`

- [ ] **Step 1: Append `resolveColor` to color.ts**

```ts
// Append to packages/shared/src/utils/color.ts

import type { StoreTheme } from '../types/store-theme';

export type ColorValue = string;

export const COLOR_TOKENS = [
  'primary',
  'secondary',
  'accent',
  'card',
  'muted',
  'foreground',
  'border',
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

const TOKEN_PREFIX = 'token:';

/**
 * Resolve a `ColorValue` string to an actual CSS color.
 *   - 'token:<name>' → looks up StoreTheme[<name>] and wraps as hsl() if not already wrapped
 *   - raw '#RRGGBB' / '#RGB' / 'hsl(...)' → passes through unchanged
 *   - empty / undefined → undefined (caller falls back to theme default)
 */
export function resolveColor(value: ColorValue | undefined, theme: StoreTheme): string | undefined {
  if (!value) return undefined;

  if (value.startsWith(TOKEN_PREFIX)) {
    const key = value.slice(TOKEN_PREFIX.length) as ColorToken;
    if (!(COLOR_TOKENS as readonly string[]).includes(key)) return undefined;
    const raw = (theme as unknown as Record<string, string | undefined>)[key];
    if (!raw) return undefined;
    return raw.startsWith('hsl(') || raw.startsWith('#') ? raw : `hsl(${raw})`;
  }

  return value;
}
```

- [ ] **Step 2: Run the resolveColor tests**

```bash
npx vitest run packages/shared/src/utils/color.test.ts -t "resolveColor" 2>&1 | tail -10
```

Expected: all 5 `resolveColor` tests PASS.

---

## Task 5: Implement `pickReadableForeground`

**Files:**

- Modify: `packages/shared/src/utils/color.ts`

- [ ] **Step 1: Append `pickReadableForeground` to color.ts**

```ts
// Append to packages/shared/src/utils/color.ts

/**
 * Returns the optimal text color ('#ffffff' or '#000000') for a given background
 * using the WCAG relative-luminance flip threshold (0.179).
 *
 * Returns undefined when the input can't be parsed — caller falls back to the
 * theme's foreground value.
 */
export function pickReadableForeground(bg: string | undefined): '#ffffff' | '#000000' | undefined {
  const rgb = parseColorToRgb(bg);
  if (!rgb) return undefined;
  const lum = relativeLuminance(rgb);
  // 0.179 is the standard WCAG flip point where contrast against black and white
  // is balanced. Above → use black; below or equal → use white.
  return lum > 0.179 ? '#000000' : '#ffffff';
}
```

- [ ] **Step 2: Run the pickReadableForeground tests**

```bash
npx vitest run packages/shared/src/utils/color.test.ts -t "pickReadableForeground" 2>&1 | tail -10
```

Expected: all 5 `pickReadableForeground` tests PASS.

---

## Task 6: Implement `contrastRatio`

**Files:**

- Modify: `packages/shared/src/utils/color.ts`

- [ ] **Step 1: Append `contrastRatio` to color.ts**

```ts
// Append to packages/shared/src/utils/color.ts

/**
 * WCAG contrast ratio between two colors. Returns 1.0 to 21.0.
 *   - AA normal text: ≥ 4.5
 *   - AA large text:  ≥ 3.0
 *   - AAA normal:     ≥ 7.0
 *
 * Returns 1.0 (worst case) when either input is unparseable so the caller
 * always gets a safe number to compare against thresholds.
 */
export function contrastRatio(bg: string, fg: string): number {
  const bgRgb = parseColorToRgb(bg);
  const fgRgb = parseColorToRgb(fg);
  if (!bgRgb || !fgRgb) return 1;
  const bgLum = relativeLuminance(bgRgb);
  const fgLum = relativeLuminance(fgRgb);
  const brighter = Math.max(bgLum, fgLum);
  const darker = Math.min(bgLum, fgLum);
  return (brighter + 0.05) / (darker + 0.05);
}
```

- [ ] **Step 2: Run the full test suite**

```bash
npx vitest run packages/shared/src/utils/color.test.ts 2>&1 | tail -15
```

Expected: all 20+ tests PASS (5 parse + 5 resolve + 5 pickReadable + 4 contrast = 19).

---

## Task 7: Export the helpers from `@force/shared`

**Files:**

- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add the re-exports**

Run `grep -n "export \*\|export {" packages/shared/src/index.ts | head -20` to see the existing structure, then add at the end:

```ts
// Color helpers (smart-color resolver + contrast utilities)
export {
  resolveColor,
  pickReadableForeground,
  contrastRatio,
  parseColorToRgb,
  relativeLuminance,
  COLOR_TOKENS,
} from './utils/color';
export type { ColorValue, ColorToken, Rgb } from './utils/color';
```

- [ ] **Step 2: Build the shared package**

```bash
npm run build -w packages/shared 2>&1 | tail -5
```

Expected: build succeeds, no TypeScript errors.

- [ ] **Step 3: Commit Tasks 2–7**

```bash
git add packages/shared/src/utils/color.ts packages/shared/src/utils/color.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): color helpers for smart contrast + brand-token resolution"
```

---

## Task 8: Storefront — section-bg helper applies auto-fix

**Files:**

- Modify: `apps/web/src/templates/shared/section-bg.ts`

- [ ] **Step 1: Update the helper to resolve + auto-fix**

Read the current file to see the existing signature. Then replace its body with:

```ts
import type { CSSProperties } from 'react';
import { resolveColor, pickReadableForeground } from '@force/shared';
import type { StoreTheme } from '@force/shared';

/**
 * Map a per-section bgColor (hex OR token:<name>) to an inline style object that
 * sets backgroundColor AND a `--section-fg` CSS custom property with the
 * auto-picked readable foreground. Returns undefined when no bg is set so the
 * section falls back to its theme-level background.
 *
 * The `--section-fg` cascades into the section's heading/kicker/subtitle text
 * via globals.css so a merchant who picks brand primary as bg never ships
 * unreadable headings.
 */
export function sectionBgStyle(
  bgColor: string | undefined,
  theme: StoreTheme
): CSSProperties | undefined {
  const resolved = resolveColor(bgColor, theme);
  if (!resolved) return undefined;
  const fg = pickReadableForeground(resolved);
  return {
    backgroundColor: resolved,
    ...(fg ? ({ ['--section-fg' as string]: fg } as CSSProperties) : {}),
  };
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck 2>&1 | grep -E "section-bg|color.ts" | head -10
```

Expected: no errors specifically in `section-bg.ts` or `color.ts`. Pre-existing unrelated errors are fine.

---

## Task 9: HomePageContent passes theme to section-bg

**Files:**

- Modify: `apps/web/src/app/HomePageContent.tsx`

- [ ] **Step 1: Find existing `sectionBgStyle(...)` call sites**

```bash
grep -n "sectionBgStyle" apps/web/src/app/HomePageContent.tsx
```

- [ ] **Step 2: Pass `theme` to each call**

The store theme is already available — find it via `grep -n "useStore\|store\.theme\|theme:" apps/web/src/app/HomePageContent.tsx | head -5`. The component should already have access to `store.theme` (or resolves it from `StoreContext`).

For every `sectionBgStyle(layout.<section>.bgColor)` call, change to:

```tsx
sectionBgStyle(layout.<section>.bgColor, store.theme)
```

If `store.theme` isn't already in scope, read it via `useStore()` near the top of the component:

```tsx
const { store } = useStore();
const theme = store?.theme;
```

And gate the calls with `theme ?? DEFAULT_THEME` if the type requires non-undefined; otherwise pass `theme` and let `resolveColor` handle the empty case.

- [ ] **Step 3: Verify the build**

```bash
npm run build -w apps/web 2>&1 | tail -10
```

Expected: "✓ Compiled successfully" with no Type errors in HomePageContent.tsx.

---

## Task 10: Storefront — section-scoped text color cascade

**Files:**

- Modify: `apps/web/src/app/globals.css` (or wherever the section-level CSS lives — find via `grep -rn "data-section\|data-zone" apps/web/src/app/globals.css apps/web/src/app/layout.tsx`)

- [ ] **Step 1: Add the cascade rule**

Append to `apps/web/src/app/globals.css`:

```css
/**
 * Section-scoped auto-fix: when a section sets --section-fg via inline style
 * (driven by pickReadableForeground in section-bg.ts), every heading / kicker /
 * subtitle inside that section adopts the auto-picked color. Falls back to
 * currentColor when no section bg has been set, so existing tenants see
 * zero behavior change.
 */
[data-section] [data-zone='sectionHeading'],
[data-section] [data-zone='sectionKicker'],
[data-section] [data-zone='sectionSubtitle'] {
  color: var(--section-fg, currentColor);
}
```

- [ ] **Step 2: Verify each section wrapper has `data-section`**

```bash
grep -n "data-section" apps/web/src/app/HomePageContent.tsx apps/web/src/templates/shared/*.tsx
```

If any section wrapper lacks `data-section="<key>"`, add it. The 5 wrappers that need it: hero, categories, newArrivals, bestSellers, testimonials.

- [ ] **Step 3: Run the web build**

```bash
npm run build -w apps/web 2>&1 | tail -5
```

Expected: green.

- [ ] **Step 4: Commit Tasks 8–10**

```bash
git add apps/web/src/templates/shared/section-bg.ts apps/web/src/app/HomePageContent.tsx apps/web/src/app/globals.css
git commit -m "feat(web): section-scoped auto-fix of heading text contrast"
```

---

## Task 11: Admin — `ColorContrastPreview` component

**Files:**

- Create: `apps/admin/src/components/ColorContrastPreview.tsx`

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { resolveColor, pickReadableForeground, contrastRatio } from '@force/shared';
import type { StoreTheme } from '@force/shared';

interface ColorContrastPreviewProps {
  /** Current ColorField value — hex, 'token:<name>', or empty. */
  bg: string | undefined;
  /** Store theme to resolve tokens against. */
  theme: StoreTheme;
  /** Optional merchant-picked foreground from the corresponding typography zone. */
  pickedFg?: string;
}

const HEADING_AA_MIN = 4.5; // WCAG AA normal text
const LARGE_AA_MIN = 3.0; // WCAG AA large text

export function ColorContrastPreview({ bg, theme, pickedFg }: ColorContrastPreviewProps) {
  const resolved = resolveColor(bg, theme);
  if (!resolved) return null;

  const autoFg = pickReadableForeground(resolved) ?? '#000000';
  const tokenName = bg?.startsWith('token:') ? bg.slice(6) : null;
  const displayLabel = tokenName
    ? `${tokenName.charAt(0).toUpperCase() + tokenName.slice(1)} (${resolved})`
    : resolved;

  const merchantRatio = pickedFg ? contrastRatio(resolved, pickedFg) : null;
  const autoRatio = contrastRatio(resolved, autoFg);

  const warn = merchantRatio !== null && merchantRatio < HEADING_AA_MIN;

  return (
    <div className="mt-2 rounded-lg border border-border p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-foreground">Background: {displayLabel}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{resolved}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(['Heading', 'Subtitle', 'Body / CTA'] as const).map(role => (
          <div
            key={role}
            className="rounded p-2 text-center"
            style={{ backgroundColor: resolved, color: autoFg }}
          >
            {role}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">
          Auto-fixed: <span className="font-mono">{autoFg}</span> · WCAG {autoRatio.toFixed(1)} : 1{' '}
          {autoRatio >= HEADING_AA_MIN ? '✓' : autoRatio >= LARGE_AA_MIN ? '⚠' : '✗'}
        </span>
        {warn && merchantRatio !== null ? (
          <span className="text-amber-600">
            ⚠ Picked text {merchantRatio.toFixed(1)} : 1 — AA needs {HEADING_AA_MIN} : 1
          </span>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it imports cleanly**

```bash
npm run typecheck 2>&1 | grep "ColorContrastPreview" | head -5
```

Expected: no output (no errors).

---

## Task 12: Admin — extract + revise `ColorField` component

**Files:**

- Create: `apps/admin/src/components/ColorField.tsx`
- Modify: `apps/admin/src/app/stores/[id]/layout/page.tsx`

- [ ] **Step 1: Create the standalone component**

```tsx
'use client';

import { ColorContrastPreview } from './ColorContrastPreview';
import { COLOR_TOKENS } from '@force/shared';
import type { StoreTheme } from '@force/shared';

interface ColorFieldProps {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  hint?: string;
  /** Store theme — required so the brand-token dropdown can resolve tokens for the preview. */
  theme: StoreTheme | undefined;
  /** Optional merchant-picked foreground color (from a typography zone) for the preview warning. */
  previewFg?: string;
}

const TOKEN_LABELS: Record<(typeof COLOR_TOKENS)[number], string> = {
  primary: 'Brand: Primary',
  secondary: 'Brand: Secondary',
  accent: 'Brand: Accent',
  card: 'Surface: Card',
  muted: 'Surface: Muted',
  foreground: 'Text: Foreground',
  border: 'Border',
};

const CUSTOM = '__custom__';

export function ColorField({ label, value, onChange, hint, theme, previewFg }: ColorFieldProps) {
  const isToken = value?.startsWith('token:') ?? false;
  const tokenName = isToken ? (value as string).slice(6) : '';
  const hexValue = !isToken ? value || '' : '';

  const selectValue = isToken ? tokenName : value ? CUSTOM : '';

  const handleSelectChange = (next: string) => {
    if (next === '') {
      onChange('');
    } else if (next === CUSTOM) {
      onChange(hexValue || '#ffffff');
    } else {
      onChange(`token:${next}`);
    }
  };

  return (
    <div className="flex flex-col gap-2 py-2">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <select
          value={selectValue}
          onChange={e => handleSelectChange(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="">— Theme default —</option>
          {COLOR_TOKENS.map(t => (
            <option key={t} value={t}>
              {TOKEN_LABELS[t]}
            </option>
          ))}
          <option value={CUSTOM}>Custom hex…</option>
        </select>
        {!isToken && value ? (
          <input
            type="color"
            value={hexValue || '#ffffff'}
            onChange={e => onChange(e.target.value)}
            className="h-8 w-12 cursor-pointer rounded border border-border bg-background"
          />
        ) : null}
        {value ? (
          <button
            type="button"
            onClick={() => onChange('')}
            className="text-xs text-muted-foreground underline"
          >
            Clear
          </button>
        ) : null}
      </div>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      {value && theme ? (
        <ColorContrastPreview bg={value} theme={theme} pickedFg={previewFg} />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Delete the inline `ColorField` declaration from layout/page.tsx**

Find the declaration (around line 936) and remove the entire function. Replace any existing call sites' imports with:

```tsx
import { ColorField } from '../../../../components/ColorField';
```

- [ ] **Step 3: Pass `theme` to every `<ColorField>` call site**

The page needs to read `storeInfo?.theme` and pass it as the `theme` prop. Add to the page-level component (around line 41 where `storeInfo` is declared):

```tsx
// theme is on StoreInfo; if not, extend the interface
```

If `StoreInfo` doesn't currently have a `theme` field, extend it. Otherwise read from existing fetch payload. Run:

```bash
grep -n "interface StoreInfo\|theme" apps/admin/src/app/stores/\[id\]/layout/page.tsx | head -10
```

For every `<ColorField ...>` invocation, add `theme={storeInfo?.theme}`.

- [ ] **Step 4: Run the admin build**

```bash
npm run build -w apps/admin 2>&1 | tail -10
```

Expected: "✓ Compiled successfully" — must complete the "Running TypeScript" pass without errors. Per `feedback-fwb-vercel-strict-ts-vs-local`, local typecheck alone is insufficient.

- [ ] **Step 5: Run the 4-grep detection recipe**

```bash
# Type
grep -n "ColorValue\|COLOR_TOKENS\|colorValue" packages/shared/src/utils/color.ts packages/shared/src/index.ts
# Zod
grep -n "colorValue\|token:" apps/api/src/routes/store-layout.routes.ts
# Wiring
grep -n "sectionBgStyle\|resolveColor" apps/web/src/app/HomePageContent.tsx apps/web/src/templates/shared/section-bg.ts
# Consumer (admin)
grep -n "ColorField\|ColorContrastPreview" apps/admin/src/app/stores/\[id\]/layout/page.tsx apps/admin/src/components/ColorField.tsx apps/admin/src/components/ColorContrastPreview.tsx
```

All four must return ≥1 match.

- [ ] **Step 6: Commit Tasks 11–12**

```bash
git add apps/admin/src/components/ColorField.tsx apps/admin/src/components/ColorContrastPreview.tsx apps/admin/src/app/stores/\[id\]/layout/page.tsx
git commit -m "feat(admin): colorfield with brand-token dropdown + live contrast preview"
```

---

## Task 13: Phase 1 acceptance — browser-qa visual sweep

- [ ] **Step 1: Start dev servers**

```bash
npm run dev:web &
npm run dev:admin &
```

- [ ] **Step 2: Open admin → Layout for a tenant on the elegant theme** (e.g. wadyaljuz). Set Categories bg to `Brand: Primary`. Save.

- [ ] **Step 3: Verify the preview band**

In admin: the preview band shows `Background: Primary (hsl(...))` with three sample lozenges. Auto-fixed color displays correctly. WCAG ratio shows ≥ 4.5 : 1 if the brand primary luminance is dark, ≤ 4.5 if bright.

- [ ] **Step 4: Open the storefront** for the same tenant. Verify Categories section bg is the brand primary AND the section heading is auto-flipped to white (or black, whichever passes contrast).

- [ ] **Step 5: Test the referential semantics**

Change the brand primary in `/branding` to a different color. Reload the storefront. Categories bg should update WITHOUT re-saving the layout. (Confirms `token:primary` resolves at render time, not at save.)

- [ ] **Step 6: Test the warning band**

Set Categories bg to `#FFFF00` (yellow) via Custom hex. Preview band should show `⚠ Heading text 2.4 : 1 — Storefront will auto-fix to black.` Storefront renders Categories with yellow bg + black heading.

- [ ] **Step 7: Push**

```bash
git push origin main
```

Watch the Vercel admin + Vercel web + Railway API deploys for green.

---

# Phase 2 — Page Builder merge

## Task 14: Rename route + add redirects

**Files:**

- Move: `apps/admin/src/app/stores/[id]/layout/page.tsx` → `apps/admin/src/app/stores/[id]/page-builder/page.tsx`
- Modify: `apps/admin/next.config.ts` (or wherever Next config lives — check via `ls apps/admin/next.config.*`)

- [ ] **Step 1: Move the file**

```bash
mkdir -p apps/admin/src/app/stores/\[id\]/page-builder
git mv apps/admin/src/app/stores/\[id\]/layout/page.tsx apps/admin/src/app/stores/\[id\]/page-builder/page.tsx
rmdir apps/admin/src/app/stores/\[id\]/layout 2>/dev/null
```

- [ ] **Step 2: Add 301 redirects to next.config.ts**

Find the existing config (`ls apps/admin/next.config.*`) and add to its `async redirects()` export (create if missing):

```ts
async redirects() {
  return [
    {
      source: '/stores/:id/layout',
      destination: '/stores/:id/page-builder',
      permanent: true,
    },
    {
      source: '/stores/:id/typography',
      destination: '/stores/:id/page-builder',
      permanent: true,
    },
  ];
}
```

- [ ] **Step 3: Verify the route resolves**

```bash
npm run build -w apps/admin 2>&1 | grep "page-builder\|Type error"
```

Expected: `/stores/[id]/page-builder` appears in the build's route list.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/app/stores/\[id\]/page-builder apps/admin/next.config.ts
git commit -m "feat(admin): rename layout route to page-builder + 301 redirects from old urls"
```

---

## Task 15: Extract `<ZoneEditor>` from typography page

**Files:**

- Create: `apps/admin/src/components/ZoneEditor.tsx`
- Modify: `apps/admin/src/app/stores/[id]/typography/page.tsx` (refactor to use the extracted component before deletion in Task 17)

- [ ] **Step 1: Read the current typography page to identify the per-zone editor structure**

```bash
grep -nE "function .*Zone|ZONES\[|ZoneRow" apps/admin/src/app/stores/\[id\]/typography/page.tsx | head -20
```

Identify the existing per-zone editor sub-component (likely an inline `ZoneRow` or similar). The extracted component must accept these props:

```ts
interface ZoneEditorProps {
  zoneKey: string;
  zoneLabel: string;
  values: ZoneValues; // font, size, weight, color, etc.
  onChange: (next: Partial<ZoneValues>) => void;
}
```

- [ ] **Step 2: Write the extracted component**

Copy the relevant editor JSX + handlers from the typography page into the new component file. Keep the existing form-control conventions (`SelectField`, `RowToggle`, etc.).

Extended props (beyond the original typography page's inline editor) to support per-section overrides in Task 16:

```tsx
// apps/admin/src/components/ZoneEditor.tsx
'use client';
import type { ZoneOverride, StoreTheme } from '@force/shared';
import { ColorField } from './ColorField';

interface ZoneEditorProps {
  zoneKey: string;
  zoneLabel: string;
  values: ZoneOverride;
  /** Resolved zone the merchant is inheriting from — shown as faded placeholder text inside empty fields. */
  placeholder?: ZoneOverride;
  onChange: (next: Partial<ZoneOverride>) => void;
  /** Optional: clear the entire override and return to inheriting from the placeholder source. */
  onReset?: () => void;
  /** Required for the embedded ColorField — resolves brand-token color picks. */
  theme: StoreTheme | undefined;
}

// Body: faithfully extracted from the typography page's inline per-zone editor,
// PLUS:
//   - When `placeholder?.<field>` is set AND `values?.<field>` is empty, render the
//     field's input with `placeholder={placeholder[field]}` so merchant sees what
//     they'd inherit.
//   - When `onReset` is provided AND any value is set, render a small "Reset to
//     default" link at the bottom of the editor that calls `onReset()`.
//   - Replace the color picker invocation with `<ColorField theme={theme} ... />`
//     (already shipped in Phase 1) so per-section color overrides get the brand-token
//     dropdown for free.
```

(Exact field-by-field structure depends on the current typography page implementation — read it first and faithfully extract.)

- [ ] **Step 3: Refactor the typography page to use the extracted component**

Replace the inline per-zone editors with `<ZoneEditor zoneKey={...} values={...} onChange={...} />` invocations. Same data flow.

- [ ] **Step 4: Build admin to confirm no regression**

```bash
npm run build -w apps/admin 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/ZoneEditor.tsx apps/admin/src/app/stores/\[id\]/typography/page.tsx
git commit -m "refactor(admin): extract zoneeditor for reuse in page-builder"
```

---

## Task 15b: Per-section typography overrides — types + Zod + resolver

**Files:**

- Modify: `packages/shared/src/types/store-layout.ts`
- Modify: `apps/api/src/routes/store-layout.routes.ts`
- Create: `apps/web/src/templates/shared/section-typography.ts`

This task adds the data model + resolver for Part 4 of the spec (per-section typography overrides). Lands BEFORE the admin UI distribution (Task 16) so the underlying contract is ready.

- [ ] **Step 1: Add `ZoneOverride` + `SectionTypographyOverride` types**

In `packages/shared/src/types/store-layout.ts`, add ABOVE `HeroSettings`:

```ts
export interface ZoneOverride {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  /** Hex color OR 'token:<name>' — same shape as section bgColor. */
  color?: string;
  letterSpacing?: string;
  lineHeight?: string;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
}

export interface SectionTypographyOverride {
  heading?: ZoneOverride;
  kicker?: ZoneOverride;
  subtitle?: ZoneOverride;
  /** Body / paragraph override — non-title text inside this section. */
  body?: ZoneOverride;
}
```

- [ ] **Step 2: Mix `typography?: SectionTypographyOverride` into the section interfaces**

Add the field to `HeroSettings`, `CategoriesSettings`, `ProductCarouselSettings`, `TestimonialsSettings`:

```ts
export interface CategoriesSettings extends SectionTitleOverride, SectionBgOverride {
  // ... existing fields ...
  /** Per-section typography overrides — wins over global typography zones. */
  typography?: SectionTypographyOverride;
}
```

- [ ] **Step 3: Add Zod validators**

In `apps/api/src/routes/store-layout.routes.ts`, add ABOVE the existing schemas:

```ts
const zoneOverride = z
  .object({
    fontFamily: z.string().max(120).optional(),
    fontSize: z.string().max(40).optional(),
    fontWeight: z.string().max(10).optional(),
    color: colorValue,
    letterSpacing: z.string().max(20).optional(),
    lineHeight: z.string().max(20).optional(),
    textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional(),
  })
  .partial()
  .optional();

const sectionTypographyOverride = z
  .object({
    heading: zoneOverride,
    kicker: zoneOverride,
    subtitle: zoneOverride,
    body: zoneOverride,
  })
  .partial()
  .optional();
```

Then add `typography: sectionTypographyOverride` to each of: `heroSchema`, `categoriesSchema`, `newArrivalsSchema` / `bestSellersSchema` (or their shared `productCarouselSchema`), `testimonialsSchema`.

- [ ] **Step 4: Write the section-typography resolver**

```ts
// apps/web/src/templates/shared/section-typography.ts
import { resolveColor } from '@force/shared';
import type { ZoneOverride, StoreTheme } from '@force/shared';

export interface ResolvedZone {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  color?: string;
  letterSpacing?: string;
  lineHeight?: string;
  textTransform?: string;
}

/**
 * Merge a section-level typography override with the global zone from the
 * typography admin. Section override wins per-field; global fills the rest;
 * theme defaults handle anything not set anywhere. Returns undefined when
 * neither has any value so the caller can render with raw theme defaults.
 *
 * Color values (hex OR 'token:<name>') are resolved against the live theme
 * here so the consumer always gets a real CSS color string.
 */
export function resolveSectionZone(
  sectionOverride: ZoneOverride | undefined,
  globalZone: ZoneOverride | undefined,
  theme: StoreTheme
): ResolvedZone | undefined {
  if (!sectionOverride && !globalZone) return undefined;

  const merged: ResolvedZone = {};
  const pick = <K extends keyof ZoneOverride>(key: K) => {
    const v = sectionOverride?.[key] ?? globalZone?.[key];
    if (v !== undefined) {
      (merged as Record<string, unknown>)[key] = v;
    }
  };

  pick('fontFamily');
  pick('fontSize');
  pick('fontWeight');
  pick('letterSpacing');
  pick('lineHeight');
  pick('textTransform');

  // Color goes through resolveColor so token: refs work at the override level too.
  const rawColor = sectionOverride?.color ?? globalZone?.color;
  if (rawColor) {
    merged.color = resolveColor(rawColor, theme);
  }

  return Object.keys(merged).length ? merged : undefined;
}
```

- [ ] **Step 5: Build + commit**

```bash
npm run build -w packages/shared 2>&1 | tail -3
npm run build -w apps/api 2>&1 | tail -3
npm run build -w apps/web 2>&1 | tail -3
```

All three green, then:

```bash
git add packages/shared/src/types/store-layout.ts apps/api/src/routes/store-layout.routes.ts apps/web/src/templates/shared/section-typography.ts
git commit -m "feat(shared,api,web): per-section typography overrides with resolver"
```

---

## Task 15c: Storefront consumes per-section typography

**Files:**

- Modify: `apps/web/src/app/HomePageContent.tsx`
- Modify: storefront section components that render section headings (find via `grep -rln "data-zone=.sectionHeading\|data-zone=.sectionKicker" apps/web/src`)

This task wires the resolver into the actual render path so per-section overrides actually appear on the storefront. Without this step, the data model exists but does nothing.

- [ ] **Step 1: Identify the section heading render component**

```bash
grep -rln "data-zone=.sectionHeading.\|data-zone=.sectionKicker." apps/web/src/templates apps/web/src/app | head -10
```

Most likely candidates: `apps/web/src/templates/shared/SectionHeading.tsx` or similar.

- [ ] **Step 2: Update the SectionHeading component to accept resolved zone props**

```tsx
import type { ResolvedZone } from './section-typography';

interface SectionHeadingProps {
  // ... existing props ...
  /** Resolved heading style (per-section override merged with global zone). */
  headingZone?: ResolvedZone;
  kickerZone?: ResolvedZone;
  subtitleZone?: ResolvedZone;
}

// In the JSX, apply via inline style on the wrapper:
<h2
  data-zone="sectionHeading"
  style={{
    fontFamily: headingZone?.fontFamily,
    fontSize: headingZone?.fontSize,
    fontWeight: headingZone?.fontWeight,
    color: headingZone?.color,
    letterSpacing: headingZone?.letterSpacing,
    lineHeight: headingZone?.lineHeight,
    textTransform: headingZone?.textTransform as React.CSSProperties['textTransform'],
  }}
>
  {title}
</h2>;
```

The auto-fixed `--section-fg` still wins via the globals.css cascade IF a section bg is set AND the resolved color would fail contrast. Otherwise the inline style applies the merchant's picked color.

- [ ] **Step 3: In `HomePageContent.tsx`, resolve + pass for each section**

For every section that has a `<SectionHeading>` (or equivalent), resolve its zones BEFORE rendering:

```tsx
import { resolveSectionZone } from '../templates/shared/section-typography';

// Inside the component:
const categoriesHeadingZone = resolveSectionZone(
  layout.categories.typography?.heading,
  globalZones.sectionHeading,
  store.theme
);
const categoriesKickerZone = resolveSectionZone(
  layout.categories.typography?.kicker,
  globalZones.sectionKicker,
  store.theme
);
const categoriesSubtitleZone = resolveSectionZone(
  layout.categories.typography?.subtitle,
  globalZones.sectionSubtitle,
  store.theme
);
```

The `globalZones` value comes from the existing typography API fetch. If it isn't currently wired into HomePageContent, plumb it from the page-level server fetch.

Pass the resolved zones into the existing `<SectionHeading>` or template component:

```tsx
<SectionHeading
  title={...}
  headingZone={categoriesHeadingZone}
  kickerZone={categoriesKickerZone}
  subtitleZone={categoriesSubtitleZone}
/>
```

Repeat for hero / newArrivals / bestSellers / testimonials.

- [ ] **Step 4: Run the auto-fix priority check**

The CSS cascade order matters. Verify:

```css
/* globals.css — auto-fix MUST win over inline color when bg is set */
[data-section][style*='--section-fg'] [data-zone='sectionHeading'],
[data-section][style*='--section-fg'] [data-zone='sectionKicker'],
[data-section][style*='--section-fg'] [data-zone='sectionSubtitle'] {
  color: var(--section-fg) !important;
}
```

The `!important` is needed because inline `style="color: red"` would otherwise win over a CSS rule. The auto-fix is structural (prevents invisible text); merchant's picked color is cosmetic. Auto-fix wins.

Update `apps/web/src/app/globals.css` to include this stricter rule alongside the rule added in Task 10.

- [ ] **Step 5: Build + commit**

```bash
npm run build -w apps/web 2>&1 | tail -5
```

Expected: green.

```bash
git add apps/web/src/app/HomePageContent.tsx apps/web/src/app/globals.css apps/web/src/templates/shared/SectionHeading.tsx
git commit -m "feat(web): render per-section typography with auto-fix priority cascade"
```

---

## Task 15d: Smart Palette generator helper

**Files:**

- Modify: `packages/shared/src/utils/color.ts` (append helpers)
- Modify: `packages/shared/src/utils/color.test.ts` (append tests)

This is a NEW task added 2026-05-19 per Ahmad's directive "I want a UI to give colors and it set smartly for all the sections as cards frame color, background color, and font color." The Phase 1 auto-fix solves _render-time_ contrast; this task adds _admin-time_ palette intelligence — pick 1–3 seed colors and the system distributes them across every section's bg + frame + heading color as a coherent palette.

- [ ] **Step 1: Write failing tests for `generateSectionPalette`**

Append to `packages/shared/src/utils/color.test.ts`:

```ts
import { generateSectionPalette, lightenColor, darkenColor } from './color';

describe('lightenColor / darkenColor', () => {
  it('lightenColor pushes toward white', () => {
    const lighter = lightenColor('#FF6E00', 0.4);
    expect(lighter).not.toBe('#FF6E00');
    // Result should be parseable + have higher luminance than the seed.
    const seedLum = relativeLuminance(parseColorToRgb('#FF6E00')!);
    const lightLum = relativeLuminance(parseColorToRgb(lighter)!);
    expect(lightLum).toBeGreaterThan(seedLum);
  });

  it('darkenColor pushes toward black', () => {
    const darker = darkenColor('#FF6E00', 0.4);
    const seedLum = relativeLuminance(parseColorToRgb('#FF6E00')!);
    const darkLum = relativeLuminance(parseColorToRgb(darker)!);
    expect(darkLum).toBeLessThan(seedLum);
  });
});

describe('generateSectionPalette', () => {
  it('with one seed: alternates seed bg / neutral bg across sections', () => {
    const palette = generateSectionPalette({ primary: '#FF6E00' });
    expect(palette.hero.bgColor).toBe('#FF6E00');
    expect(palette.categories.bgColor).toMatch(/^#/); // some neutral
    expect(palette.newArrivals.bgColor).not.toBe(palette.categories.bgColor);
    expect(palette.bestSellers.bgColor).toBe(palette.categories.bgColor); // neutrals match
    expect(palette.testimonials.bgColor).toBe('#FF6E00'); // seed returns at end
  });

  it('every section gets cardFrameColor = primary seed', () => {
    const palette = generateSectionPalette({ primary: '#FF6E00' });
    for (const section of [
      'hero',
      'categories',
      'newArrivals',
      'bestSellers',
      'testimonials',
    ] as const) {
      expect(palette[section].cardFrameColor).toBe('#FF6E00');
    }
  });

  it('every section heading color auto-fixes against its bg', () => {
    const palette = generateSectionPalette({ primary: '#FF6E00' });
    expect(palette.hero.headingColor).toBe('#000000'); // black on orange (correct AA)
    expect(palette.categories.headingColor).toBe('#000000'); // black on light neutral
  });

  it('with primary + accent: accent populates alternating bg slots', () => {
    const palette = generateSectionPalette({ primary: '#FF6E00', accent: '#0066CC' });
    expect(palette.hero.bgColor).toBe('#FF6E00');
    expect(palette.newArrivals.bgColor).toBe('#0066CC'); // accent gets a slot
  });

  it('passes token refs through unchanged for the caller to resolve at render', () => {
    const palette = generateSectionPalette({ primary: 'token:primary' });
    expect(palette.hero.bgColor).toBe('token:primary');
    expect(palette.hero.cardFrameColor).toBe('token:primary');
    // Heading color still picked from the resolved seed — caller passes theme separately when resolving.
    // The helper returns 'auto' as a sentinel meaning "auto-fix at render".
    expect(palette.hero.headingColor).toBe('auto');
  });
});
```

- [ ] **Step 2: Run tests — expect every test to FAIL**

```bash
npx vitest run packages/shared/src/utils/color.test.ts -t "lightenColor\|darkenColor\|generateSectionPalette" 2>&1 | tail -10
```

Expected: 6 tests fail with "is not a function" or similar.

- [ ] **Step 3: Implement `lightenColor` / `darkenColor`**

Append to `packages/shared/src/utils/color.ts`:

```ts
/**
 * Mix a color toward white by `amount` (0..1). For `'#FF6E00'` + 0.4 returns a
 * lighter orange suitable for tinted section backgrounds. Token refs pass
 * through unchanged so the caller can resolve at render time.
 */
export function lightenColor(input: string, amount: number): string {
  if (input.startsWith('token:')) return input;
  const rgb = parseColorToRgb(input);
  if (!rgb) return input;
  const t = Math.max(0, Math.min(1, amount));
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return rgbToHex({ r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b) });
}

/**
 * Mix a color toward black by `amount` (0..1). For `'#FF6E00'` + 0.4 returns a
 * darker shade suitable for hover states / framed sections.
 */
export function darkenColor(input: string, amount: number): string {
  if (input.startsWith('token:')) return input;
  const rgb = parseColorToRgb(input);
  if (!rgb) return input;
  const t = Math.max(0, Math.min(1, amount));
  const mix = (c: number) => Math.round(c * (1 - t));
  return rgbToHex({ r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b) });
}

function rgbToHex(rgb: Rgb): string {
  const toHex = (c: number) => c.toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}
```

- [ ] **Step 4: Implement `generateSectionPalette`**

Append to `packages/shared/src/utils/color.ts`:

```ts
export interface PaletteSeeds {
  primary: ColorValue;
  accent?: ColorValue;
  neutral?: ColorValue;
}

export interface SectionPaletteEntry {
  bgColor: ColorValue;
  cardFrameColor: ColorValue;
  /**
   * Heading text color. Returns `'auto'` when the bg is a token ref — caller
   * must resolve the token at render time and call `pickReadableForeground`
   * then. Returns a concrete hex when the bg is a concrete hex.
   */
  headingColor: string;
}

export type SectionKey = 'hero' | 'categories' | 'newArrivals' | 'bestSellers' | 'testimonials';

const SECTION_ORDER: SectionKey[] = [
  'hero',
  'categories',
  'newArrivals',
  'bestSellers',
  'testimonials',
];

/**
 * Distribute 1–3 seed colors across the 5 storefront section settings as a
 * coherent palette. Alternates seed-bg / neutral-bg across sections; the
 * accent (if provided) fills one slot. Card frame is the primary seed
 * everywhere for brand consistency. Heading color auto-fixes per section bg.
 *
 * Token-ref seeds pass through unchanged so the caller can resolve at render.
 */
export function generateSectionPalette(
  seeds: PaletteSeeds
): Record<SectionKey, SectionPaletteEntry> {
  const { primary, accent, neutral } = seeds;
  const neutralBg = neutral ?? '#FFFFFF';

  const slots: Record<SectionKey, ColorValue> = {
    hero: primary,
    categories: neutralBg,
    newArrivals:
      accent ??
      lightenColor(
        typeof primary === 'string' && primary.startsWith('token:') ? '#FFFFFF' : primary,
        0.6
      ),
    bestSellers: neutralBg,
    testimonials: primary,
  };

  const headingFor = (bg: ColorValue): string => {
    if (bg.startsWith('token:')) return 'auto';
    return pickReadableForeground(bg) ?? '#000000';
  };

  return SECTION_ORDER.reduce(
    (acc, key) => {
      acc[key] = {
        bgColor: slots[key],
        cardFrameColor: primary,
        headingColor: headingFor(slots[key]),
      };
      return acc;
    },
    {} as Record<SectionKey, SectionPaletteEntry>
  );
}
```

- [ ] **Step 5: Run tests — expect all 6 new tests PASS**

```bash
npx vitest run packages/shared/src/utils/color.test.ts 2>&1 | tail -10
```

Expected: 25 tests pass (19 original + 6 new).

- [ ] **Step 6: Re-export from `@force/shared`**

In `packages/shared/src/utils/index.ts`, append to the existing re-exports:

```ts
export { lightenColor, darkenColor, generateSectionPalette } from './color';
export type { PaletteSeeds, SectionPaletteEntry, SectionKey } from './color';
```

- [ ] **Step 7: Build + commit**

```bash
npm run build -w packages/shared 2>&1 | tail -3
```

```bash
git add packages/shared/src/utils/color.ts packages/shared/src/utils/color.test.ts packages/shared/src/utils/index.ts
git commit -m "feat(shared): smart palette generator distributes seeds across section settings"
```

---

## Task 15e: Smart Palette modal + page-builder integration

**Files:**

- Create: `apps/admin/src/components/SmartPaletteModal.tsx`
- Modify: `apps/admin/src/app/stores/[id]/page-builder/page.tsx` (the renamed file from Task 14)

Lands AFTER Task 14 (route rename) so we edit the new path.

- [ ] **Step 1: Write the modal component**

```tsx
'use client';

import { useState } from 'react';
import { generateSectionPalette, COLOR_TOKENS } from '@force/shared';
import type { StoreTheme, SectionKey, PaletteSeeds, SectionPaletteEntry } from '@force/shared';
import { ColorField } from './ColorField';
import { ColorContrastPreview } from './ColorContrastPreview';

interface SmartPaletteModalProps {
  open: boolean;
  onClose: () => void;
  onApply: (palette: Record<SectionKey, SectionPaletteEntry>) => void;
  theme: StoreTheme | undefined;
}

export function SmartPaletteModal({ open, onClose, onApply, theme }: SmartPaletteModalProps) {
  const [primary, setPrimary] = useState<string>('token:primary');
  const [accent, setAccent] = useState<string>('');
  const [neutral, setNeutral] = useState<string>('');

  if (!open) return null;

  const seeds: PaletteSeeds = {
    primary,
    accent: accent || undefined,
    neutral: neutral || undefined,
  };
  const palette = primary ? generateSectionPalette(seeds) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-foreground">Smart palette</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Pick 1–3 colors and we'll distribute them across every section's background, card frame,
          and heading color. Section text auto-fixes for contrast.
        </p>

        <div className="space-y-3">
          <ColorField
            label="Primary (required)"
            value={primary}
            onChange={setPrimary}
            theme={theme}
          />
          <ColorField
            label="Accent (optional — fills one alternating slot)"
            value={accent}
            onChange={setAccent}
            theme={theme}
          />
          <ColorField
            label="Neutral (optional — defaults to white)"
            value={neutral}
            onChange={setNeutral}
            theme={theme}
          />
        </div>

        {palette ? (
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Preview</h3>
            <div className="grid grid-cols-5 gap-2">
              {(['hero', 'categories', 'newArrivals', 'bestSellers', 'testimonials'] as const).map(
                key => (
                  <div
                    key={key}
                    className="aspect-[3/4] rounded-lg border-2 p-2 text-center text-[10px]"
                    style={{
                      backgroundColor: palette[key].bgColor.startsWith('token:')
                        ? '#eee'
                        : palette[key].bgColor,
                      borderColor: palette[key].cardFrameColor.startsWith('token:')
                        ? '#888'
                        : palette[key].cardFrameColor,
                      color:
                        palette[key].headingColor === 'auto' ? '#000' : palette[key].headingColor,
                    }}
                  >
                    <div className="font-semibold capitalize">{key}</div>
                  </div>
                )
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Token refs (e.g. <code>token:primary</code>) preview as gray here; storefront resolves
              at render.
            </p>
          </div>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!palette) return;
              if (!confirm('This overwrites the current section bg + frame colors. Proceed?'))
                return;
              onApply(palette);
              onClose();
            }}
            disabled={!palette}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            Apply to all sections
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add a "Smart palette" button at the top of the page builder**

In `apps/admin/src/app/stores/[id]/page-builder/page.tsx`, near the existing Save button in `<AdminLayout actions={...}>`, add:

```tsx
const [paletteOpen, setPaletteOpen] = useState(false);

// Inside actions:
<button
  type="button"
  onClick={() => setPaletteOpen(true)}
  className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted transition-colors cursor-pointer"
>
  Smart palette
</button>;
```

- [ ] **Step 3: Mount the modal + wire onApply**

At the bottom of the page's JSX (inside the AdminLayout but outside the form):

```tsx
<SmartPaletteModal
  open={paletteOpen}
  onClose={() => setPaletteOpen(false)}
  theme={storeInfo?.theme}
  onApply={palette => {
    setLayout(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        hero: { ...prev.hero, bgColor: palette.hero.bgColor },
        categories: {
          ...prev.categories,
          bgColor: palette.categories.bgColor,
          cardFrameColor: palette.categories.cardFrameColor,
        },
        newArrivals: {
          ...prev.newArrivals,
          bgColor: palette.newArrivals.bgColor,
          cardFrameColor: palette.newArrivals.cardFrameColor,
        },
        bestSellers: {
          ...prev.bestSellers,
          bgColor: palette.bestSellers.bgColor,
          cardFrameColor: palette.bestSellers.cardFrameColor,
        },
        testimonials: { ...prev.testimonials, bgColor: palette.testimonials.bgColor },
      };
    });
  }}
/>
```

The palette generator returns `headingColor` per section but we DON'T persist it as a per-section typography override here — Phase 1's render-time auto-fix already picks the right heading color from the section bg. The per-section typography editor (Task 16) lets the merchant override deliberately.

- [ ] **Step 4: Build admin**

```bash
npm run build -w apps/admin 2>&1 | tail -5
```

Expected: "✓ Compiled successfully".

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/SmartPaletteModal.tsx apps/admin/src/app/stores/\[id\]/page-builder/page.tsx
git commit -m "feat(admin): smart palette modal distributes seeds across all sections"
```

---

## Task 16: Distribute zones under section cards

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/page-builder/page.tsx`

- [ ] **Step 1: Add the per-section override editors inside each section card**

Per the updated spec Part 4, each storefront section gets ITS OWN typography editor block writing to `layout.<section>.typography.{heading,kicker,subtitle,body}`. Global zones become platform-level defaults in a separate "Default typography" card at the bottom.

In `apps/admin/src/app/stores/[id]/page-builder/page.tsx`, import the extracted ZoneEditor:

```tsx
import { ZoneEditor } from '../../../../components/ZoneEditor';
import type { SectionTypographyOverride, ZoneOverride } from '@force/shared';
```

- [ ] **Step 2: Add ZoneEditor blocks inside each existing section card with per-section binding**

For every `<SectionCard title="Hero" | "Categories" | "New Arrivals" | "Best Sellers" | "Testimonials">`, append at the bottom of its children:

```tsx
<div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
    Section typography (overrides default)
  </h4>
  {(['heading', 'kicker', 'subtitle'] as const).map(role => (
    <ZoneEditor
      key={role}
      zoneKey={`<section>.typography.${role}`}
      zoneLabel={`Section ${role}`}
      values={layout.<section>.typography?.[role] ?? {}}
      placeholder={defaults.section${capitalize(role)}}  // shows the resolved global as a faded hint
      onChange={next =>
        updateSection('<section>', s => ({
          ...s,
          typography: {
            ...(s.typography ?? {}),
            [role]: { ...(s.typography?.[role] ?? {}), ...next },
          },
        }))
      }
      onReset={() =>
        updateSection('<section>', s => {
          const { [role]: _, ...rest } = s.typography ?? {};
          return { ...s, typography: Object.keys(rest).length ? rest : undefined };
        })
      }
      theme={storeInfo?.theme}
    />
  ))}
</div>
```

The `placeholder` prop on `<ZoneEditor>` shows the resolved global zone value as a faded hint when the per-section override is unset, so the merchant sees what they're inheriting. `onReset` clears the per-section override entirely (returns to inheriting global).

- [ ] **Step 3: Add a separate "Default typography" SectionCard at the bottom of the page**

This is where global zones still live (for backward compatibility and for sections / zones that don't have per-section overrides). Mirror the current `/typography` page structure but inside one collapsible `<details>` block:

```tsx
<SectionCard
  title="Default typography (platform-level)"
  description="These defaults apply to every section that hasn't set its own override above."
  enabled={true}
  onToggle={() => {}}
>
  {(
    [
      'sectionHeading',
      'sectionKicker',
      'sectionSubtitle',
      'heroHeadline',
      'heroCta',
      'announcementBar',
      'headerNav',
      'storeName',
      'footerLink',
      'footerLegal',
      'productCardName',
      'productCardPrice',
      'productCardCta',
      'afterFooter',
    ] as const
  ).map(zoneKey => (
    <ZoneEditor
      key={zoneKey}
      zoneKey={zoneKey}
      zoneLabel={t(`typography.zones.${zoneKey}`)}
      values={globalZones[zoneKey] ?? {}}
      onChange={next =>
        setGlobalZones(prev => ({ ...prev, [zoneKey]: { ...prev[zoneKey], ...next } }))
      }
      theme={storeInfo?.theme}
    />
  ))}
</SectionCard>
```

- [ ] **Step 4: Fetch the global zones alongside layout + store**

In the page's data-fetch effect:

```tsx
const [layoutRes, storeRes, typographyRes] = await Promise.all([
  apiGet<{ layout: StoreLayoutSettings }>(`/api/v1/admin/stores/${storeId}/layout`),
  apiGet<{ store: StoreInfo }>(`/api/v1/admin/stores/${storeId}`),
  apiGet<{ zones: Record<string, ZoneOverride> }>(`/api/v1/admin/stores/${storeId}/typography`),
]);
if (typographyRes.data?.zones) setGlobalZones(typographyRes.data.zones);
```

(Verify endpoint path via `grep -rn "router.get.*typography" apps/api/src/routes/typography.routes.ts` — adjust accordingly.)

- [ ] **Step 3: Add new SectionCards for Announcement bar / Header / Footer / Cross-cutting**

These don't currently exist as Layout sections but DO have typography zones. Add minimal cards above/below the existing ones in storefront order. Each card contains only its ZoneEditor blocks (no layout controls since those don't exist for these sections).

- [ ] **Step 4: Build**

```bash
npm run build -w apps/admin 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/app/stores/\[id\]/page-builder/page.tsx
git commit -m "feat(admin): distribute typography zones under section cards"
```

---

## Task 17: Unified save + delete old typography route

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/page-builder/page.tsx` (save handler)
- Delete: `apps/admin/src/app/stores/[id]/typography/page.tsx`
- Modify: sidebar component (find via `grep -rln 'Layout\|Typography' apps/admin/src/components/AdminLayout.tsx apps/admin/src/components/Sidebar.tsx 2>/dev/null`)
- Modify: `apps/admin/src/contexts/LanguageContext.tsx` (remove orphan keys)

- [ ] **Step 1: Update `handleSave` to persist both layout + typography**

```tsx
const handleSave = async () => {
  if (!layout) return;
  setIsSaving(true);
  try {
    const [layoutResult, typographyResult] = await Promise.allSettled([
      apiPut(`/api/v1/admin/stores/${storeId}/layout`, layout),
      apiPut(`/api/v1/admin/stores/${storeId}/typography`, { zones: typography }),
    ]);

    const layoutFailed =
      layoutResult.status === 'rejected' ||
      (layoutResult.status === 'fulfilled' && layoutResult.value.error);
    const typographyFailed =
      typographyResult.status === 'rejected' ||
      (typographyResult.status === 'fulfilled' && typographyResult.value.error);

    if (layoutFailed && typographyFailed) {
      toastError(t('saveError'));
    } else if (layoutFailed) {
      toastError(t('saveErrorLayoutOnly'));
    } else if (typographyFailed) {
      toastError(t('saveErrorTypographyOnly'));
    } else {
      toastSuccess(t('saved'));
    }
  } finally {
    setIsSaving(false);
  }
};
```

- [ ] **Step 2: Add the new toast keys to LanguageContext.tsx**

```ts
saveErrorLayoutOnly: 'Layout saved, but typography failed. Retry the typography save.',
saveErrorTypographyOnly: 'Typography saved, but layout failed. Retry the layout save.',
```

(Arabic translations too.)

- [ ] **Step 3: Delete the old typography page file**

```bash
git rm apps/admin/src/app/stores/\[id\]/typography/page.tsx
rmdir apps/admin/src/app/stores/\[id\]/typography 2>/dev/null
```

- [ ] **Step 4: Update the sidebar**

Find the sidebar entries:

```bash
grep -rn "stores/\[id\]/layout\|stores/\[id\]/typography" apps/admin/src/components apps/admin/src/contexts | head -10
```

In the sidebar component:

- Rename "Layout" → "Page Builder"
- Remove the "Typography" entry
- Update the href from `/stores/${id}/layout` → `/stores/${id}/page-builder`

In `LanguageContext.tsx`:

- Rename `sidebar.layout` → `sidebar.pageBuilder` (en + ar)
- Remove `sidebar.typography` key (en + ar)

- [ ] **Step 5: Run full admin build**

```bash
npm run build -w apps/admin 2>&1 | tail -15
```

Expected: green. The 301 redirect from Task 14 ensures old URLs work; the sidebar now points only to the new URL.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/app/stores/\[id\]/page-builder/page.tsx apps/admin/src/components apps/admin/src/contexts/LanguageContext.tsx
git rm apps/admin/src/app/stores/\[id\]/typography/page.tsx
git commit -m "feat(admin): unified save + remove old typography route + sidebar rename"
```

---

## Task 18: Phase 2 acceptance — browser-qa visual sweep

- [ ] **Step 1: Start admin dev server**

```bash
npm run dev:admin
```

- [ ] **Step 2: Verify the redirects work**

In the browser, navigate to `http://localhost:3001/stores/<id>/layout` → should 301 to `/stores/<id>/page-builder`.

Navigate to `http://localhost:3001/stores/<id>/typography` → same destination.

- [ ] **Step 3: Verify sidebar entries**

Sidebar shows "Page Builder" (NOT "Layout"). "Typography" entry is gone.

- [ ] **Step 4: Verify each section card contains both Layout + Typography controls**

Scroll through the page. Each storefront section's card shows:

- Layout controls (enabled, bg color via the new dropdown, card size, etc.)
- ZoneEditor blocks for each owned typography zone
- ColorContrastPreview band below the bg color picker

- [ ] **Step 5: Save flow**

Edit a section's heading font + the section's bg color in one go. Click Save. Toast says "Saved" if both API calls succeeded. Refresh — both values persist.

- [ ] **Step 6: Failure-path test**

Temporarily disable the typography API endpoint (or simulate via network throttling). Save. Toast says "Layout saved, but typography failed. Retry the typography save."

- [ ] **Step 7: Push**

```bash
git push origin main
```

Watch the Vercel admin deploy for green. Browser-test on the deployed admin at https://app.forcemediakw.com/stores/<id>/page-builder.

---

# Final wrap-up

## Task 19: Memory + graph refresh

- [ ] **Step 1: Run graphify update**

```bash
graphify update . 2>&1 | tail -3
```

- [ ] **Step 2: Write memory note for the smart-color pattern**

Create `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/feedback-fwb-smart-color-system.md` documenting:

- The token vs hex string convention (`'token:<name>'` prefix)
- The `resolveColor` + `pickReadableForeground` + `contrastRatio` helper trio
- The section-scoped `--section-fg` CSS var cascade
- The ColorContrastPreview admin component
- Why the auto-fix is structural (text contrast), not cosmetic (theme identity)

- [ ] **Step 3: Write memory note for the Page Builder merge**

Create `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/feedback-fwb-page-builder-pattern.md` documenting:

- The decision to merge Layout + Typography into one URL
- The SECTION_ZONES ownership map
- The unified save pattern (Promise.allSettled with partial-failure toasts)
- The 301-redirect migration path

- [ ] **Step 4: Add both entries to MEMORY.md index**

- [ ] **Step 5: Update vault**

Add a callout to `~/Desktop/projects/calude code meomry/wiki/projects/force-website-builder.md` summarizing this batch.

- [ ] **Step 6: Run the memory pipeline**

```bash
nohup ~/.claude/scripts/update-memory-pipeline.sh project force-website-builder > /tmp/update-memory-smart-color.log 2>&1 &
disown
```

- [ ] **Step 7: Commit graphify-out**

```bash
git add graphify-out
git commit -m "chore(graphify): refresh after smart-color + page-builder sprint"
git push origin main
```

---

## Self-review notes

**Spec coverage:** All 7 spec sections map to tasks (see the coverage table at the top). Task 13 covers Phase 1 acceptance criteria 1-4; Task 18 covers Phase 2 acceptance criteria 1-4. Migration / backwards compat covered by Tasks 1 (Zod accepts existing hex strings), 14 (redirects), 17 (orphan key cleanup). The "open questions" in the spec (HSL→RGB parsing, RTL admin UX, scroll length, parallel save failure) are all addressed inline in Tasks 3 (parser unit tests), 12+13 (build gate catches RTL issues), 16 (`<details>` collapsing), 17 (Promise.allSettled).

**Placeholder scan:** Searched for "TBD" / "fill in" / "TODO" / "etc." — none in the plan body. Task 15 has one "(exact code depends on the current implementation)" callout because the ZoneEditor extraction is a faithful refactor of existing code, not new design — the engineer must read the current typography page first. That's acceptable per the plan-writing guidance (refactor of existing code with clear constraints).

**Type consistency:** `ColorValue`, `ColorToken`, `COLOR_TOKENS`, `resolveColor`, `pickReadableForeground`, `contrastRatio`, `parseColorToRgb`, `relativeLuminance` — all spelled identically across Task 2 (test), Tasks 3-6 (implementation), Task 7 (re-export), Task 8 (consumer), Task 11 (admin preview), Task 12 (admin ColorField). `sectionBgStyle` signature `(bgColor, theme)` matches between Tasks 8 + 9.

---

**Estimated effort:** Phase 1 = ~3-4 hours focused work (Tasks 1-13). Phase 2 = ~4-6 hours (Tasks 14-18) — largest risk is Task 15 (ZoneEditor extraction) since it depends on the shape of the existing typography page code, which the plan only references rather than reproduces. Final wrap-up (Task 19) = ~30 min.

**Largest gating dependency between phases:** Phase 2 inherits the new `ColorField` component from Phase 1. Phase 1 MUST ship clean before Phase 2 begins.
