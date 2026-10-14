# Page Builder UX Consolidation (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`.

**Goal:** Eliminate the "two settings overriding each other" confusion Ahmad surfaced 2026-05-19. Move all section-scoped typography zones (sectionTitle/sectionKicker/sectionSubtitle/sectionSeeAll/productName/productPrice/productCta/categoryLabel) OUT of the global "Default typography" card and INTO each section's per-section block. Add collapsible section cards, brand-as-default color inheritance, live per-section preview tiles (with cardFrameWidth + bgColor + frame color rendered), and a Smart Palette v2 with distribution patterns + interactive preview where the merchant can tune `cardFrameWidth` before applying.

**Architecture:** Phase 3 is admin-only — zero storefront changes and zero data-model changes. The data shape from Phase 2 (per-section `layout.<section>.typography.{heading,kicker,subtitle,body}` + global zones) is already correct; Phase 3 just rearranges the admin UI to make it obvious which control affects what. The "Default typography" card shrinks to truly-platform zones (header, footer, afterFooter, announcementBar, storeName). Each section card gains a live preview tile that renders an SVG-or-DOM mockup of the section with the current bgColor + cardFrameColor + cardFrameWidth + headingColor applied. Smart Palette v2 swaps its simple confirm() for an inline interactive preview where the merchant clicks each section's tile to inspect/adjust the proposed values, with a cardFrameWidth slider per section.

**Tech Stack:** React (Next.js 16 App Router for apps/admin), Tailwind CSS, the existing `@ebda/shared` helpers (`generateSectionPalette`, `pickReadableForeground`, `resolveColor`).

**Spec reference:** The data model + storefront cascade are already shipped by Phase 2 (`docs/superpowers/plans/2026-05-18-smart-colors-and-page-builder.md`). Phase 3 only restructures the admin UI to match the merchant's mental model — no spec doc needed.

---

## Spec coverage map

| Ask (Ahmad 2026-05-19)                                                                                                            | Wave    |
| --------------------------------------------------------------------------------------------------------------------------------- | ------- |
| "Why have two settings for everything and one overrides something" → move section-specific zones into per-section blocks          | 3A      |
| "Make each part as a menu so it closes and opens on demand" → collapsible `<details>`                                             | 3A      |
| "While there is branding then the theme default colors must be overridden by default" → brand-as-default inheritance              | 3B      |
| "Make a preview for every part and section so changes can be seen before saving" → live per-section preview tile                  | 3C      |
| "Frame size itself must be controlled as well and add it to the preview" → cardFrameWidth in preview tile + Smart Palette preview | 3C + 3D |
| "Smart palette make it better and more customizable" → distribution patterns + interactive preview                                | 3D      |

---

## File structure

**Phase 3 — admin-only:**

- **Modify**:
  - `apps/admin/src/app/stores/[id]/page-builder/page.tsx` — main reorg (Waves 3A + 3B + 3C + 3D)
  - `apps/admin/src/components/SmartPaletteModal.tsx` — distribution pattern picker + interactive preview (Wave 3D)
- **Create**:
  - `apps/admin/src/components/SectionPreview.tsx` — small visual mockup of a section with bgColor + frame + heading typography (Wave 3C)
  - `apps/admin/src/components/CollapsibleSection.tsx` (optional — could reuse existing `<SectionCard>` if it already supports collapsing; otherwise extract the `<details>` wrapper as its own component) (Wave 3A)

No backend, no shared types, no storefront changes.

---

# Wave 3A — Zone reorg + collapsible cards

## Task 1: Zone ownership rewrite

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/page-builder/page.tsx`

**Why:** Today's `<SectionTypographyBlock>` writes per-section overrides for heading/kicker/subtitle only. The global "Default typography" card duplicates those zones at the platform level (creating the "two settings for everything" confusion) PLUS hosts non-section zones (header, footer, etc). After this task: section-card typography editors gain `sectionSeeAll`, `productName`, `productPrice`, `productCta` writing as per-section overrides; "Default typography" card shrinks to only header/footer/afterFooter/announcementBar/storeName/storeLogo zones.

- [ ] **Step 1: Extend `SectionTypographyBlock` to render more roles**

Current `SectionTypographyBlock` accepts `roles: readonly ['heading', 'kicker', 'subtitle'] as const`. Extend to support `'seeAll' | 'productName' | 'productPrice' | 'productCta' | 'categoryLabel'`:

```tsx
type SectionTypographyRole =
  | 'heading'
  | 'kicker'
  | 'subtitle'
  | 'seeAll'
  | 'productName'
  | 'productPrice'
  | 'productCta'
  | 'categoryLabel';

const ROLE_LABELS: Record<SectionTypographyRole, string> = {
  heading: 'Section heading',
  kicker: 'Section kicker (chip above title)',
  subtitle: 'Section subtitle',
  seeAll: '"View All" link',
  productName: 'Product name',
  productPrice: 'Product price',
  productCta: 'Product CTA / button',
  categoryLabel: 'Category card label',
};

const ROLE_TO_GLOBAL_ZONE: Record<SectionTypographyRole, string> = {
  heading: 'sectionTitle',
  kicker: 'sectionKicker',
  subtitle: 'sectionSubtitle',
  seeAll: 'sectionSeeAll',
  productName: 'productName',
  productPrice: 'productPrice',
  productCta: 'cta',
  categoryLabel: 'categories',
};
```

The `SectionTypographyOverride` interface in `@ebda/shared` already supports arbitrary keys via partial typing — confirm via `grep -n "SectionTypographyOverride" packages/shared/src/types/store-layout.ts` and verify the type accepts these new roles. If `body` is the only currently-typed extra, extend the interface to include the new role keys explicitly:

```ts
export interface SectionTypographyOverride {
  heading?: ZoneOverride;
  kicker?: ZoneOverride;
  subtitle?: ZoneOverride;
  body?: ZoneOverride;
  seeAll?: ZoneOverride;
  productName?: ZoneOverride;
  productPrice?: ZoneOverride;
  productCta?: ZoneOverride;
  categoryLabel?: ZoneOverride;
}
```

(Modify in `packages/shared/src/types/store-layout.ts` — small additive change, doesn't break existing data.)

- [ ] **Step 2: Per-section role distribution**

Update each section's `<SectionTypographyBlock>` invocation to include the relevant roles for that section type:

| Section               | Roles                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hero                  | `['heading']`                                                                                                                                         |
| Categories            | `['heading', 'kicker', 'subtitle', 'seeAll', 'categoryLabel']`                                                                                        |
| New Arrivals          | `['heading', 'kicker', 'subtitle', 'seeAll', 'productName', 'productPrice', 'productCta']`                                                            |
| Best Sellers          | `['heading', 'kicker', 'subtitle', 'seeAll', 'productName', 'productPrice', 'productCta']`                                                            |
| Testimonials          | `['heading', 'kicker', 'subtitle']`                                                                                                                   |
| Product card defaults | `['productName', 'productPrice', 'productCta']` (catalog-wide, NOT under a section card — keep in its existing "Product card defaults" `SectionCard`) |

Confirm the existing invocation shape in the page (find via `grep -n "SectionTypographyBlock" apps/admin/src/app/stores/\[id\]/page-builder/page.tsx`) and extend the `roles` array per the table.

- [ ] **Step 3: Shrink the "Default typography" SectionCard**

Find the existing 14-zone loop (look for the literal array `['beforeHeader', 'header', ..., 'afterFooter']` or similar — `grep -n "afterFooter\|GLOBAL_ZONE_LABELS" apps/admin/src/app/stores/\[id\]/page-builder/page.tsx`). Replace with a shorter list:

```ts
const PLATFORM_GLOBAL_ZONES = [
  'beforeHeader', // announcement bar
  'header', // page header (logo + nav)
  'storeName', // store name in header
  'footer', // footer links
  'afterFooter', // below footer ("Powered by Force AI")
] as const;
```

These are the only TRULY platform-wide zones — every section uses the same one. The 9 zones removed from this list (sectionTitle / sectionKicker / sectionSubtitle / sectionSeeAll / categories / products / productName / productPrice / cta / filters) are now per-section.

Update the SectionCard title from "Default typography (platform-level)" → "Header + Footer typography (platform-wide)".

- [ ] **Step 4: Update zone-fallback resolution in `SectionTypographyBlock`**

The block currently passes `globalZones[ROLE_TO_GLOBAL_ZONE[role]]` as the placeholder to `<ZoneEditor>`. Keep this — even though those global zones are no longer shown in the "Default typography" card, the storefront's existing resolver still reads them. Legacy tenants who had set globally-applied values before this reorg keep working; the placeholder shows the inherited value so the merchant can see what they're picking up from the legacy global state.

This is a soft-cut migration: NEW tenants get the per-section model exclusively; EXISTING tenants who have set global section zones still see those values applied until they explicitly override per section.

- [ ] **Step 5: Run admin build + commit**

```bash
npm run build -w apps/admin 2>&1 | tail -5
```

```bash
git add apps/admin/src/app/stores/\[id\]/page-builder/page.tsx packages/shared/src/types/store-layout.ts
git commit -m "feat(admin): per-section typography hosts all section-specific zones (no more global/section split)"
```

## Task 2: Collapsible section cards

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/page-builder/page.tsx`

- [ ] **Step 1: Wrap each `<SectionCard>` body in `<details>`**

Find the `<SectionCard>` component definition (likely inline in the page or extracted). Add a `defaultExpanded` prop that controls whether `<details open>` or `<details>` wraps the children. Each section card invocation passes `defaultExpanded={layout.<section>.enabled ?? false}` so enabled sections render expanded, disabled ones collapsed.

```tsx
function SectionCard({
  title,
  description,
  enabled,
  onToggle,
  defaultExpanded,
  children,
}: SectionCardProps) {
  return (
    <details
      open={defaultExpanded}
      className="rounded-2xl border border-border bg-card transition-colors"
    >
      <summary className="cursor-pointer list-none px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {/* The enabled toggle stays outside the disclosure so merchant can flip without expanding */}
          <Toggle checked={enabled} onChange={onToggle} aria-label={`Enable ${title}`} />
        </div>
      </summary>
      <div className="border-t border-border px-4 py-3 sm:px-6 sm:py-4 space-y-4">{children}</div>
    </details>
  );
}
```

The summary contains title + description + enable toggle, so the merchant can toggle enabled without opening the card. The body renders only when `<details>` is open.

- [ ] **Step 2: Add "Expand all" / "Collapse all" controls at the top of the page**

Place above the first section card:

```tsx
<div className="mb-3 flex items-center justify-end gap-2 text-xs">
  <button
    type="button"
    onClick={() => document.querySelectorAll('details').forEach(d => (d.open = true))}
    className="text-muted-foreground hover:text-foreground underline"
  >
    Expand all
  </button>
  <span className="text-muted-foreground">·</span>
  <button
    type="button"
    onClick={() => document.querySelectorAll('details').forEach(d => (d.open = false))}
    className="text-muted-foreground hover:text-foreground underline"
  >
    Collapse all
  </button>
</div>
```

DOM-mutation approach because React state per-card would be a much bigger refactor; `<details>` is uncontrolled and these one-shot buttons toggle the native DOM property cheaply.

- [ ] **Step 3: Build + commit**

```bash
git add apps/admin/src/app/stores/\[id\]/page-builder/page.tsx
git commit -m "feat(admin): collapsible page-builder section cards + expand/collapse all controls"
```

---

# Wave 3B — Brand-as-default color inheritance

## Task 3: ColorField empty state shows brand value when set

**Files:**

- Modify: `apps/admin/src/components/ColorField.tsx`

- [ ] **Step 1: Determine the inherited default**

The ColorField currently shows "— Theme default —" in the dropdown when `value` is empty. When the store has brand colors set, the empty state should show "Brand: Primary (#FF6E00)" instead — that's the effective inherited value at render.

Pass an additional prop `inheritFromToken?: ColorToken` so the caller can specify which token represents the inherited default for THIS specific picker:

```tsx
interface ColorFieldProps {
  // ... existing props
  /**
   * When `value` is empty, show this token's resolved color as a faded preview
   * so the merchant sees what they'd inherit. Falls back to no preview when
   * the token isn't set on the theme.
   */
  inheritFromToken?: ColorToken;
}
```

In the render, when `value` is empty AND `inheritFromToken` is set AND `theme[<token>Color]` resolves to a non-empty string, render the dropdown's selected option label as `"Brand: Primary (resolved hex)"` instead of `"— Theme default —"`. The actual stored value stays empty (unset = inherit) — only the visual cue changes.

- [ ] **Step 2: Wire `inheritFromToken` at the call sites**

In `page-builder/page.tsx`, audit each `<ColorField>` invocation. For:

- Section `bgColor` pickers → `inheritFromToken="card"` (the default section bg is the card/surface token)
- Section `cardFrameColor` pickers → `inheritFromToken="border"` (the default frame color is the theme border)
- Per-section typography color pickers (heading/kicker/subtitle) → `inheritFromToken="foreground"` (default text is theme foreground)
- Per-section CTA color pickers (productCta) → `inheritFromToken="primary"` (default CTA is brand primary)

- [ ] **Step 3: Build + commit**

```bash
git add apps/admin/src/components/ColorField.tsx apps/admin/src/app/stores/\[id\]/page-builder/page.tsx
git commit -m "feat(admin): colorfield empty state shows inherited brand token (override-by-default)"
```

---

# Wave 3C — Live per-section preview tile

## Task 4: `<SectionPreview>` component

**Files:**

- Create: `apps/admin/src/components/SectionPreview.tsx`

- [ ] **Step 1: Component shape**

```tsx
'use client';

import { resolveColor, pickReadableForeground } from '@ebda/shared';
import type { StoreTheme, CardFrameWidth } from '@ebda/shared';

interface SectionPreviewProps {
  /** Section name displayed inside the preview tile ("Hero" / "Categories" / etc). */
  label: string;
  /** Resolved section bg — hex or token:<name> from layout.<section>.bgColor. */
  bgColor: string | undefined;
  /** Resolved card frame color from layout.<section>.cardFrameColor. */
  cardFrameColor: string | undefined;
  /** Frame width — controls the border-N tailwind class on the preview's inner card. */
  cardFrameWidth: CardFrameWidth | undefined;
  /** Section heading typography override (color used, plus fontFamily/weight if set). */
  headingZone: { color?: string; fontFamily?: string; fontWeight?: string } | undefined;
  /** Required for token resolution. */
  theme: StoreTheme;
}

const WIDTH_CLASS: Record<CardFrameWidth, string> = {
  thin: 'border',
  normal: 'border-2',
  thick: 'border-4',
  xthick: 'border-8',
};

export function SectionPreview({
  label,
  bgColor,
  cardFrameColor,
  cardFrameWidth,
  headingZone,
  theme,
}: SectionPreviewProps) {
  const resolvedBg = resolveColor(bgColor, theme) ?? '#FFFFFF';
  const autoFg = pickReadableForeground(resolvedBg) ?? '#000000';
  const headingColor = resolveColor(headingZone?.color, theme) ?? autoFg;
  const resolvedFrame = resolveColor(cardFrameColor, theme) ?? '#E5E7EB';
  const widthClass = WIDTH_CLASS[cardFrameWidth ?? 'thin'];

  return (
    <div className="rounded-lg p-4 text-center" style={{ backgroundColor: resolvedBg }}>
      <p
        className="mb-2 text-xs font-semibold uppercase tracking-wider"
        style={{
          color: headingColor,
          fontFamily: headingZone?.fontFamily,
          fontWeight: headingZone?.fontWeight,
        }}
      >
        {label} heading
      </p>
      <div className="grid grid-cols-3 gap-2">
        {[1, 2, 3].map(i => (
          <div
            key={i}
            className={`aspect-square rounded ${widthClass} bg-white/40`}
            style={{ borderColor: resolvedFrame }}
          />
        ))}
      </div>
    </div>
  );
}
```

This renders a small visual mockup: section bg with the heading text on top + 3 card-frame swatches showing the bg + frame color + frame width. Updates live as merchant edits.

- [ ] **Step 2: Mount inside each section card in page-builder**

Below each section's controls in `page-builder/page.tsx`, add the preview tile. Compute the inputs from the section's current settings + the relevant per-section heading typography:

```tsx
<SectionPreview
  label="Categories"
  bgColor={layout.categories.bgColor}
  cardFrameColor={layout.categories.cardFrameColor}
  cardFrameWidth={layout.categories.cardFrameWidth}
  headingZone={layout.categories.typography?.heading}
  theme={storeInfo?.theme ?? FALLBACK_THEME}
/>
```

Where `FALLBACK_THEME` is a minimal default StoreTheme constant declared near the top of the page file so the preview never blank-renders if the store theme hasn't loaded yet.

Same pattern for hero, newArrivals, bestSellers, testimonials. Hero doesn't have cardFrameColor/cardFrameWidth (it's not a card-grid section) so pass `undefined` for those.

- [ ] **Step 3: Build + commit**

```bash
git add apps/admin/src/components/SectionPreview.tsx apps/admin/src/app/stores/\[id\]/page-builder/page.tsx
git commit -m "feat(admin): live per-section preview tile renders bg + frame + heading typography"
```

---

# Wave 3D — Smart Palette v2 (distribution + interactive preview)

## Task 5: Distribution-pattern picker + interactive preview

**Files:**

- Modify: `apps/admin/src/components/SmartPaletteModal.tsx`
- Modify: `packages/shared/src/utils/color.ts` (extend `generateSectionPalette` to accept a `pattern` option)

- [ ] **Step 1: Extend the generator**

Add a `pattern` option to `PaletteSeeds`:

```ts
export type PalettePattern = 'alternating' | 'monochrome' | 'triad' | 'single-bg';

export interface PaletteSeeds {
  primary: ColorValue;
  accent?: ColorValue;
  neutral?: ColorValue;
  pattern?: PalettePattern;
  /** Per-section override picked by merchant via the modal's interactive preview. */
  overrides?: Partial<Record<SectionKey, Partial<SectionPaletteEntry>>>;
  /** Default cardFrameWidth applied to all card-grid sections. */
  cardFrameWidth?: CardFrameWidth;
}
```

Distribution logic per pattern:

| Pattern                         | Hero    | Categories | NewArrivals         | BestSellers | Testimonials |
| ------------------------------- | ------- | ---------- | ------------------- | ----------- | ------------ |
| `alternating` (current default) | primary | neutral    | accent or seed-tint | neutral     | primary      |
| `monochrome`                    | primary | primary    | primary             | primary     | primary      |
| `triad`                         | primary | neutral    | accent              | primary     | neutral      |
| `single-bg`                     | neutral | neutral    | neutral             | neutral     | neutral      |

Update `generateSectionPalette` to switch on `seeds.pattern` (default `'alternating'`), apply per-section overrides on top of the pattern-derived defaults, and use `seeds.cardFrameWidth` (default `'normal'`) for every section.

Add unit tests for the 4 patterns + the override-on-top behavior. Run the suite — confirm all pass.

- [ ] **Step 2: Pattern picker UI in the modal**

```tsx
<div className="mb-4">
  <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
    Distribution pattern
  </label>
  <div className="grid grid-cols-4 gap-2">
    {(['alternating', 'monochrome', 'triad', 'single-bg'] as const).map(p => (
      <button
        key={p}
        type="button"
        onClick={() => setPattern(p)}
        className={`rounded border p-2 text-xs font-medium capitalize ${
          pattern === p
            ? 'border-primary bg-primary/10 text-foreground'
            : 'border-border bg-background text-muted-foreground hover:bg-muted'
        }`}
      >
        {p.replace('-', ' ')}
      </button>
    ))}
  </div>
</div>
```

- [ ] **Step 3: cardFrameWidth slider in the modal**

Above the preview grid, add a row of `cardFrameWidth` options (thin / normal / thick / xthick) so the merchant picks the global frame thickness for the palette. State held in `const [paletteFrameWidth, setPaletteFrameWidth] = useState<CardFrameWidth>('normal');`. Pass into the `generateSectionPalette` call via `seeds.cardFrameWidth`.

The preview tiles now render with `cardFrameWidth` reflected (per Wave 3C's `<SectionPreview>` component which already shows the width).

- [ ] **Step 4: Interactive preview tile clicks**

Each preview tile becomes a `<button>` that opens an inline editor below the tile. Editor lets the merchant override the auto-computed values for that section:

```tsx
{(['hero', 'categories', 'newArrivals', 'bestSellers', 'testimonials'] as const).map(key => (
  <div key={key}>
    <button
      type="button"
      onClick={() => setExpandedSection(prev => (prev === key ? null : key))}
      className="w-full"
    >
      <SectionPreview ... />
    </button>
    {expandedSection === key ? (
      <div className="mt-2 rounded border border-primary/30 bg-muted/30 p-2 space-y-2">
        <ColorField label="Override bg for this section" value={overrides[key]?.bgColor} onChange={...} theme={theme} />
        <ColorField label="Override frame for this section" value={overrides[key]?.cardFrameColor} onChange={...} theme={theme} />
        {/* cardFrameWidth select */}
      </div>
    ) : null}
  </div>
))}
```

When the merchant clicks Apply, `onApply` is called with the FINAL `Record<SectionKey, SectionPaletteEntry>` (post-overrides). The page-builder's `onApply` handler stays the same — writes bgColor + cardFrameColor + cardFrameWidth per section.

- [ ] **Step 5: Build + commit**

```bash
npm run build -w packages/shared && npx vitest run packages/shared/src/utils/color.test.ts
npm run build -w apps/admin 2>&1 | tail -5
```

```bash
git add packages/shared/src/utils/color.ts packages/shared/src/utils/color.test.ts apps/admin/src/components/SmartPaletteModal.tsx
git commit -m "feat(admin,shared): smart palette v2 — distribution patterns + interactive preview + cardframewidth"
```

---

# Wave 3E — Verification + push + memory

## Task 6: Full verification

- [ ] **Step 1**: `npm run typecheck`
- [ ] **Step 2**: `npm run build -w packages/shared && npm run build -w apps/web && npm run build -w apps/admin` — all three green
- [ ] **Step 3**: `npx vitest run packages/shared/src/utils/color.test.ts` — all tests pass
- [ ] **Step 4**: Browser-QA visual sweep on dev:admin (per `CLAUDE.md` rule 10):
  - Page-builder loads with sections collapsed for disabled ones, open for enabled
  - Click "Collapse all" → all close. Click "Expand all" → all open
  - Each section card shows the live preview tile below its controls; tile updates as merchant edits bgColor or frame
  - "Default typography" card at the bottom shows ONLY the 5 platform zones (header, footer, afterFooter, announcementBar, storeName)
  - Each section card's typography block now has heading/kicker/subtitle/seeAll AND (for product-grid sections) productName/productPrice/productCta
  - ColorField empty state shows "Brand: Primary (#FF6E00)" when /branding has brand primary set, instead of "— Theme default —"
  - Smart palette modal: 4 pattern buttons work; cardFrameWidth row above preview works; clicking a preview tile opens inline override editor

## Task 7: Push + memory + vault

- [ ] **Step 1**: `git push origin main` — Vercel admin rebuilds (web + API unchanged since this is admin-only).
- [ ] **Step 2**: Write `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-force-website-builder/memory/feedback-fwb-page-builder-phase3-consolidation.md` documenting:
  - The "section-specific zones live in section cards, NOT in the global default card" architectural decision
  - The collapsible `<details>` pattern + Expand/Collapse all DOM-mutation approach
  - The brand-as-default `inheritFromToken` prop pattern on ColorField
  - The `<SectionPreview>` component shape + where it's mounted
  - Smart Palette v2's pattern enum + interactive override flow
- [ ] **Step 3**: Add the new memory entry to scoped `MEMORY.md` index
- [ ] **Step 4**: Update `wiki/projects/force-website-builder.md` with a Phase 3 callout
- [ ] **Step 5**: `nohup ~/.claude/scripts/update-memory-pipeline.sh all > /tmp/update-memory-phase3.log 2>&1 & disown`

---

## Self-review notes

**Spec coverage:** Each of Ahmad's 6 asks (zone reorg, collapsible, brand-as-default, live preview, cardFrameWidth in preview, Smart Palette v2) has a dedicated task in a dedicated wave. The frame-width-in-preview ask is covered TWICE — once in Wave 3C (per-section preview tile) and once in Wave 3D (Smart Palette modal preview). Both surfaces honor it.

**Placeholder scan:** No "TBD" / "implement later" / vague requirements. Every step has either real code or an exact grep recipe.

**Type consistency:** `CardFrameWidth`, `ColorToken`, `SectionPreviewProps`, `PalettePattern`, `PaletteSeeds` spelled identically across all waves. `inheritFromToken` ColorField prop spelled consistently. `SectionTypographyOverride` interface extension is the only `@ebda/shared` change — additive, doesn't break existing data.

**Estimated effort:** Wave 3A ~2h, Wave 3B ~1h, Wave 3C ~2h, Wave 3D ~3h, Wave 3E (verification) ~30min. Total ~8h subagent-driven. Bundled or split per Ahmad's call.

**Largest risk:** Wave 3A's "soft-cut migration" leaves the legacy global zones readable by the storefront resolver but invisible in the admin. Tenants who had set globally-applied section colors before the reorg see those values applied until they override per section. The soft cut is the safer choice — a hard cut would require a data migration script + storefront resolver change, both of which are out of scope. Document the soft-cut behavior in the memory entry (Task 7 Step 2) so a future session doesn't think "those zones look orphaned, let me remove them".
