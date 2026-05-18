# Smart Colors + Unified Page Builder — Design

**Date:** 2026-05-18
**Status:** Approved by Ahmad 2026-05-18 (color smarts = auto-fix at render + admin warn; merge = single unified page in storefront order; color picker = brand-token dropdown + hex fallback)
**Ships in:** two phases — Phase 1 (smart colors) standalone first; Phase 2 (Page Builder merge) follows.

---

## Goals

1. **Smart colors.** The storefront auto-fixes low-contrast section text at render time so a merchant who picks brand primary as background never ships unreadable headings. The admin shows a live preview + a real WCAG ratio so the merchant knows when their pick would have failed and can correct it deliberately.
2. **Unified Page Builder.** A single admin URL where each storefront section bundles all its Layout + Typography controls in one card. Section ordering matches the storefront top-to-bottom flow (per `CLAUDE.md` rule 5).
3. **Token-aware color picker.** Every color picker is a dropdown of brand tokens (Primary / Secondary / Accent / Card / Muted / Foreground / Border) + a "Custom" escape hatch that reveals the existing hex picker. Token picks store as `'token:<name>'` and resolve to the live theme value at render so brand-color changes propagate automatically.
4. **Zero data migration.** All existing `layout_settings` JSONB + typography zone records keep working. The admin re-shuffles UI; the data model adds one prefix convention and zero schema changes.

## Non-goals (v1)

- AI "suggest a palette" button — possible v2, deferred.
- Per-device / dark-mode color theming.
- Custom token names per merchant (only the 7 built-in brand tokens are exposed).
- Auto-fixing card / CTA / form-control color (only section-scoped heading + body text).

---

## Part 1 — Smart colors

### 1.1 The `ColorValue` string convention

Color fields on `layout_settings` (`hero.bgColor`, `categories.bgColor`, `categories.cardFrameColor`, `newArrivals.bgColor`, `newArrivals.cardFrameColor`, `bestSellers.bgColor`, `bestSellers.cardFrameColor`, `testimonials.bgColor`, `productCardDefaults.cardFrameColor`) accept either form:

- **Raw hex**: `'#RRGGBB'` or `'#RGB'` (current behaviour, unchanged).
- **Token reference**: `'token:<name>'` where `<name>` is one of `primary`, `secondary`, `accent`, `card`, `muted`, `foreground`, `border`.

Zod schema validates the union via regex:

```ts
const colorValue = z
  .string()
  .regex(
    /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|token:(primary|secondary|accent|card|muted|foreground|border)|)$/,
    'Must be a hex color or token:<brand-color>'
  )
  .optional();
```

Empty string = unset (existing behaviour, falls back to the theme background preset).

### 1.2 `resolveColor` helper (`@force/shared`)

```ts
import type { StoreTheme } from './store-theme';

export type ColorValue = string;

const KNOWN_TOKENS = [
  'primary',
  'secondary',
  'accent',
  'card',
  'muted',
  'foreground',
  'border',
] as const;
type ColorToken = (typeof KNOWN_TOKENS)[number];

export function resolveColor(value: ColorValue | undefined, theme: StoreTheme): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('token:')) {
    const key = value.slice(6) as ColorToken;
    if (!KNOWN_TOKENS.includes(key)) return undefined;
    // StoreTheme stores colors as HSL triplets ("220 13% 91%"); wrap in hsl() so the result
    // is directly usable as a CSS color string.
    const raw = theme[key as keyof StoreTheme] as string | undefined;
    if (!raw) return undefined;
    return raw.startsWith('hsl(') || raw.startsWith('#') ? raw : `hsl(${raw})`;
  }
  return value; // raw hex passes through
}
```

### 1.3 `pickReadableForeground` helper (`@force/shared`)

```ts
/**
 * Returns the optimal text color (`'#ffffff'` or `'#000000'`) for a given
 * background using the WCAG relative-luminance formula. Inputs that aren't
 * resolvable to RGB return undefined (caller falls back to theme foreground).
 *
 * Handles: '#RRGGBB', '#RGB', 'hsl(H S% L%)', 'hsl(H, S%, L%)'.
 */
export function pickReadableForeground(bg: string | undefined): '#ffffff' | '#000000' | undefined {
  if (!bg) return undefined;
  const rgb = parseColorToRgb(bg);
  if (!rgb) return undefined;
  const lum = relativeLuminance(rgb);
  // WCAG: pick whichever of black/white gives ≥4.5:1 contrast; tie-break to
  // black since dark text on bright bg is the more common readable pattern.
  return lum > 0.179 ? '#000000' : '#ffffff';
}
```

The 0.179 threshold is the standard WCAG flip point (the luminance value where contrast against black and white is balanced).

### 1.4 `contrastRatio` helper (admin preview only)

```ts
export function contrastRatio(bg: string, fg: string): number {
  // Returns 1.0 to 21.0 per WCAG. Caller compares against 4.5 (AA normal text) or 3.0 (AA large text).
}
```

### 1.5 Storefront wiring

Each section's outer wrapper in `apps/web/src/app/HomePageContent.tsx` (and `apps/web/src/templates/shared/section-bg.ts` helper) reads:

```tsx
const resolvedBg = resolveColor(layout.categories.bgColor, theme);
const resolvedFg = resolvedBg ? pickReadableForeground(resolvedBg) : undefined;

<section
  style={
    {
      backgroundColor: resolvedBg,
      ...(resolvedFg ? { '--section-fg': resolvedFg } : {}),
    } as CSSProperties
  }
  data-section="categories"
>
  ...
</section>;
```

Section-scoped CSS rules in `apps/web/src/app/globals.css` (or layout.tsx CSS-in-JS):

```css
[data-section] [data-zone='sectionHeading'],
[data-section] [data-zone='sectionKicker'],
[data-section] [data-zone='sectionSubtitle'] {
  color: var(--section-fg, currentColor);
}
```

`currentColor` fallback means sections without a bg pick stay on the theme's foreground (no behaviour change for existing tenants).

**What auto-fix does NOT cover:** product card body text, CTA buttons, form fields. Those live in card chrome with their own background and aren't affected by section bg. If a merchant picks a card-frame color that clashes with the card body bg, that's a different problem and out of scope for v1.

### 1.6 Admin live preview band

A new `<ColorContrastPreview bg={resolvedBg} />` component renders below every `ColorField` in admin. It shows:

```
┌─ Background: Primary (#FF6E00) ──────────────────────────────────┐
│   Section heading      Subtitle line       Body / CTA            │
│   ┌─────────────┐     ┌────────────┐     ┌──────────────┐         │
│   │ Heading XL  │     │ Subtitle   │     │ Body text    │         │
│   │ on bg       │     │ on bg      │     │ on bg        │         │
│   └─────────────┘     └────────────┘     └──────────────┘         │
│   Auto-fixed: white · WCAG 6.2 : 1 ✓                              │
└────────────────────────────────────────────────────────────────────┘
```

When contrast against the merchant's _picked_ text color (from the corresponding typography zone) fails AA (<4.5:1 for normal text, <3:1 for large), a warning badge appears:

> ⚠ Heading text is 2.8 : 1 — WCAG AA needs 4.5 : 1. The storefront will auto-fix to white; pick a different bg if you want black headings here.

The badge teaches; the auto-fix protects. Merchant knows what the rendered site will look like before saving.

### 1.7 Admin `ColorField` component (revised)

```tsx
function ColorField({ label, value, onChange, hint, theme }: ColorFieldProps) {
  const isToken = value?.startsWith('token:');
  const tokenName = isToken ? value.slice(6) : '';
  const hexValue = !isToken ? value || '' : '';

  return (
    <div className="flex flex-col gap-2 py-2">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <select
          value={isToken ? tokenName : hexValue ? '__custom__' : ''}
          onChange={e =>
            onChange(
              e.target.value === '__custom__'
                ? hexValue || '#ffffff'
                : e.target.value
                  ? `token:${e.target.value}`
                  : ''
            )
          }
        >
          <option value="">— Theme default —</option>
          <option value="primary">Brand: Primary</option>
          <option value="secondary">Brand: Secondary</option>
          <option value="accent">Brand: Accent</option>
          <option value="card">Surface: Card</option>
          <option value="muted">Surface: Muted</option>
          <option value="foreground">Text: Foreground</option>
          <option value="border">Border</option>
          <option value="__custom__">Custom hex…</option>
        </select>
        {!isToken && value ? (
          <input
            type="color"
            value={hexValue || '#ffffff'}
            onChange={e => onChange(e.target.value)}
          />
        ) : null}
        {value ? <button onClick={() => onChange('')}>Clear</button> : null}
      </div>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      {value ? <ColorContrastPreview bg={value} theme={theme} /> : null}
    </div>
  );
}
```

The selector pattern: dropdown drives intent; hex picker reveals only when "Custom hex…" is picked.

---

## Part 2 — Unified Page Builder

### 2.1 Route + sidebar

- **New route**: `/stores/<id>/page-builder` (rename of existing `/stores/<id>/layout`).
- **301 redirects** in `apps/admin/next.config.ts`:
  - `/stores/:id/layout` → `/stores/:id/page-builder`
  - `/stores/:id/typography` → `/stores/:id/page-builder` (with `?zone=<zoneKey>` preserved for deep links from inside the codebase)
- **Sidebar**: remove "Typography" entry. Rename "Layout" → "Page Builder".

### 2.2 Section card structure

Each storefront section becomes one `<details>` element (HTML5 collapsible, no React libs needed). Default-open when the section is `enabled: true`, default-closed otherwise. Order matches the storefront flow:

1. Announcement bar
2. Header (chrome — typography only; layout lives on `/branding`)
3. Hero
4. Categories
5. New Arrivals
6. Best Sellers
7. Brand Story
8. Trust Strip
9. Blog carousel
10. Testimonials
11. Footer
12. **Product card defaults** (catalog-wide, not a storefront section but lives in the same form)
13. **Cross-cutting typography** (`poweredBy`, `cookieBanner` — small zones that don't belong under one section)

Each card contains:

- The current Layout controls for that section (enabled toggle, mode, slides/items, card size, frame, gap, **bg color**, **frame color**)
- A `<ZoneEditor zoneKey="..." />` block for each typography zone owned by this section (heading / kicker / subtitle / CTA)
- A `<ColorContrastPreview />` band at the bottom showing how the section's text on the section's bg will actually render

### 2.3 Zone ownership mapping

Current 14 typography zones get redistributed:

| Zone               | New owner card                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `announcementBar`  | Announcement bar                                                                                                   |
| `headerNav`        | Header                                                                                                             |
| `storeName`        | Header                                                                                                             |
| `heroHeadline`     | Hero                                                                                                               |
| `heroCta`          | Hero                                                                                                               |
| `sectionHeading`   | Each section (Categories, NewArrivals, BestSellers, Testimonials) — same zone key, four different preview contexts |
| `sectionKicker`    | Each section (same)                                                                                                |
| `sectionSubtitle`  | Each section (same)                                                                                                |
| `productCardName`  | Product card defaults                                                                                              |
| `productCardPrice` | Product card defaults                                                                                              |
| `productCardCta`   | Product card defaults                                                                                              |
| `footerLink`       | Footer                                                                                                             |
| `footerLegal`      | Footer                                                                                                             |
| `afterFooter`      | Cross-cutting (powered-by)                                                                                         |

The `sectionHeading` / `sectionKicker` / `sectionSubtitle` triple is platform-wide (one config, applies to every section). The card-level view shows the same control four times — that's intentional UX, not duplication: a merchant tuning Categories sees what changes the platform-level heading style would have. Saves write to the single shared zone record.

### 2.4 `<ZoneEditor zoneKey="..." />` component

Extracted from the current Typography page. Owns: font-family, size, weight, color, letter-spacing, optional line-height. Reads + writes via the existing typography API. Drop-in replacement — same data, new container.

### 2.5 Visual / behavioural details

- **Sticky save bar** at the bottom of the page-builder route (same as current Layout page) — one save action persists both layout_settings AND typography zone changes. Two parallel API calls under one button.
- **Collapsed-by-default for disabled sections** keeps the page scannable. Counter at the top: "12 of 14 sections enabled" so merchant knows scope.
- **Anchor links** from the storefront preview (a future enhancement): clicking a section on the live preview opens the corresponding card. v1 just relies on natural top-to-bottom order.

---

## Part 3 — Implementation phases

### Phase 1 — Smart colors (ships first, standalone)

Lands on the current `/layout` page (no merge yet). Smaller, lower risk, immediately useful.

- `resolveColor` + `pickReadableForeground` + `contrastRatio` helpers in `@force/shared`
- Section-scoped CSS var wiring in `HomePageContent.tsx` (5 sections × 2 wrappers each)
- Token-aware `ColorField` component in admin
- `<ColorContrastPreview />` component
- Zod schema accepts the `token:<name>` prefix
- Storefront `section-bg.ts` helper updated to call `resolveColor`

**Acceptance criteria for Phase 1:**

1. A tenant on the elegant theme sets Categories bg to `token:primary`. Storefront renders Categories section with the brand primary as bg AND section heading auto-flipped to white (or black, depending on the primary's luminance).
2. The same tenant opens admin → Layout → Categories. The preview band shows "Background: Primary (#FF6E00) · Auto-fixed: white · WCAG 6.2 : 1 ✓".
3. The tenant changes brand primary in `/branding` to `#003366`. Returns to `/layout`. Categories bg now shows "Background: Primary (#003366) · Auto-fixed: white · WCAG 12 : 1 ✓" without any save. The storefront also picks up the new color on next render. (Referential semantics confirmed.)
4. A tenant sets Categories bg to `#FFFF00` (yellow) — the preview band warns: "⚠ Heading text is 2.4 : 1 — WCAG AA needs 4.5 : 1. Storefront will auto-fix to black." Storefront indeed renders black heading on yellow bg.

### Phase 2 — Page Builder merge (ships after Phase 1)

- New route `/stores/<id>/page-builder` (rename current `/layout` page file)
- Extract `<ZoneEditor>` from current `/typography` page
- Distribute zones under section cards per the ownership mapping
- 301 redirects from `/layout` + `/typography`
- Sidebar entry rename

**Acceptance criteria for Phase 2:**

1. A merchant visits `/stores/<id>/layout` → 301 redirect lands them on `/stores/<id>/page-builder` with all their current values intact.
2. A merchant visits `/stores/<id>/typography?zone=heroHeadline` → 301 redirect lands them on `/stores/<id>/page-builder` scrolled to the Hero card with the `heroHeadline` zone editor open.
3. Editing the Categories section title font on the new page persists to the same typography zone record the old page wrote to. (Same data, new UI.)
4. Save button persists both layout_settings AND typography changes in one click. Failed partial save (one of the two endpoints errors) surfaces the right error message.

---

## Migration / backwards compat

- **No DB migration.** Existing rows untouched.
- **Old `bgColor` hex strings** continue to work (the `resolveColor` helper treats non-prefixed strings as raw hex). Merchants who never open the new dropdown see no change.
- **Old URLs** `/layout` + `/typography` 301 → `/page-builder` (and `?zone=` deep links).
- **Sidebar i18n strings** for "Typography" become orphans; remove from `translations` map in `LanguageContext.tsx`. (Translation key + Arabic entry both deleted in the same commit as the sidebar removal.)
- **Storefront unchanged for tenants who set no colors.** Auto-fix only fires when a bg is actually picked.

## Risks + open questions

- **HSL→RGB parsing edge cases.** `StoreTheme` stores colors as raw HSL strings (`"220 13% 91%"`). The `pickReadableForeground` parser must handle this format. Mitigation: explicit format-detection branch in `parseColorToRgb`; unit-test all three formats (`#RRGGBB`, `#RGB`, `"H S% L%"`).
- **Color picker UX on Arabic.** RTL admin: the dropdown + hex picker need to align correctly. Mitigation: use `flex-row` (logical), test on AR before claiming done.
- **Page Builder scroll length.** With 13 section cards stacked vertically, the page gets long. Mitigation: `<details>` collapsing + "enabled count" header + sticky save bar already in the design.
- **Two parallel API saves in Phase 2** (layout_settings + typography zones). One can succeed while the other fails. Mitigation: surface partial-failure error; offer "retry typography save" inline; document on the test plan.

## Related references

- `feedback-fwb-card-controls-consumer-trap` (scoped) — the 4-layer discipline applies to every new field (color resolution, CSS var, admin control, Zod).
- `feedback-fwb-template-overrides-pattern` (scoped) — the per-template upload-hint pattern from 2026-05-18; this design extends the broader "admin smart resolver" architecture.
- `feedback-fwb-theme-identity-audit` (scoped) — confirms the auto-fix is structural (text contrast) not cosmetic (theme identity) — uniform rule respected.
- `feedback-fwb-vercel-strict-ts-vs-local` (scoped) — Phase 1 + Phase 2 must run `npm run build -w apps/admin` AND `-w apps/web` locally before push.
- `CLAUDE.md` rule 5 — admin pages mirror storefront top-to-bottom flow. Part 2 of this design IS the canonical example of that rule applied at scale.
- `CLAUDE.md` rule 4 — ThemeTab clutter ceiling = 7 toggles. The Page Builder is the new home for everything that would have hit that ceiling in the future.
