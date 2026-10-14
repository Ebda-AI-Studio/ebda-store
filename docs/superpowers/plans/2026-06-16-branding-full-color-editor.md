# Branding full color editor + Smart Palette generator + hex fix

**Goal:** Give merchants direct control of ALL core brand colors in the Branding tab (not just the 2 the Smart Palette writes), make the Smart Palette a generator that _fills_ those fields, honor manual color choices verbatim on the storefront, and fix the broken hex input. Reverses the 2026-06-09 "color pickers retired to Page Builder" decision per Ahmad's explicit request.

**Architecture:** All color tokens already live on `StoreTheme` (23 `*Color`/`*Foreground` keys) and already drive storefront CSS vars via `themeToCssVars`. The work is (a) expose the core set as editable `ColorField`s in Branding, (b) extend the Smart Palette to write all derived keys, (c) stop `deriveBrandRoles` from overriding explicitly-set foregrounds, (d) add a real hex text input to `ColorField`. Theme `PUT` is a shallow-merge PATCH, so partial saves are safe.

**Tech Stack:** Next.js admin, `@ebda/shared` color utils, `ColorField` canonical picker, Zod theme schema (`z.record`).

---

## Decisions (from Ahmad, 2026-06-16)

- **Color set exposed:** core brand set — `primary`, `secondary`, `accent`, `background`, `foreground`, `card`, `muted`, `border` + the key text/foreground overrides (`primaryForeground`, `secondaryForeground`, `accentForeground`, `cardForeground`). NOT the status/popover/input/ring tokens (keep those auto).
- **Smart Palette:** becomes a generator that writes ALL derived core tokens into the Branding fields; merchant then tweaks each. Nothing hidden/auto-overridden afterward.
- **Auto-contrast:** honor the merchant's exact choices — `deriveBrandRoles` must only FILL a foreground that is unset, never override one the merchant set explicitly.
- **Page-builder redirect pointers:** remove the **colors** pointer from Branding (replaced by the real editor). Leave fonts/background pointers for a follow-up.

## Key files (from investigation)

- `apps/admin/src/components/page-builder/ColorField.tsx` — canonical picker; currently only `<input type="color">` (no hex text box). **Add hex text input.**
- `apps/admin/src/app/stores/[id]/branding/_components/ThemeTab.tsx` — 3 `PageBuilderPointer` blocks (colors/fonts/background). **Replace the colors pointer with the editor.**
- `apps/admin/src/components/SmartPaletteModal.tsx` (~lines 546-553) — `themeUpdates` only writes `primaryColor`+`accentColor`. **Write all core derived keys.**
- `packages/shared/src/utils/color.ts` — `generateSectionPalette` (383-490). Add/extend a `deriveCoreBrandTokens(seeds)` that returns the full core token set as HSL triplets.
- `packages/shared/src/types/store-theme.ts` — `StoreTheme` keys (93-110), `themeToCssVars` (591-647), `deriveBrandRoles`. **Make deriveBrandRoles respect explicit foregrounds.**
- `apps/api/src/routes/store.routes.ts` — theme schema is `z.record(z.string(), z.unknown())` so new keys pass through with no API change.

## Tasks

### Task 1: Add a hex text input to ColorField

**File:** `apps/admin/src/components/page-builder/ColorField.tsx`

- Alongside the native `<input type="color">`, render an `<input type="text" inputMode="text">` bound to the hex value.
- Normalization handler: accept with/without leading `#`; accept 3- or 6-digit hex (expand 3→6); on a valid hex call `onChange('#RRGGBB')`; ignore invalid partial input (don't fire onChange until valid) but keep the raw typed text in local state so the field doesn't fight the user mid-type. Commit on change-when-valid AND on blur.
- ≥44px touch target; the text input is the primary path (native picker secondary). Keep brand-token dropdown + contrast preview.
- This is the canonical ColorField (rule #14) — fixes the "RGB works, hex doesn't" bug everywhere it's used.

### Task 2: deriveBrandRoles honors explicit foregrounds

**File:** `packages/shared/src/types/store-theme.ts`

- `deriveBrandRoles(theme)` currently overrides the 4 foreground pairs at render. Change so a foreground key that is explicitly set on the theme is passed through unchanged; only compute a WCAG-safe value when the key is absent/empty.
- Keep the token-resolution fallback (rule #15): unset → `hsl(var(--<key>))`.

### Task 3: Smart Palette writes the full core token set

**Files:** `packages/shared/src/utils/color.ts`, `apps/admin/src/components/SmartPaletteModal.tsx`

- Add `deriveCoreBrandTokens({primary, accent, neutral})` in color.ts returning `{primaryColor, secondaryColor, accentColor, backgroundColor, foregroundColor, cardColor, mutedColor, borderColor, primaryForeground, accentForeground}` as HSL triplets (reuse existing helpers: `hexToHsl`, `pickReadableForeground`, `lighten/darken`, `resolveAndMix`).
- In SmartPaletteModal `onApply`, merge those into `themeUpdates` (only for non-`token:` seeds). Result: applying a palette fills every Branding color field so the merchant sees + can tweak the full result.

### Task 4: Branding color editor section

**File:** `apps/admin/src/app/stores/[id]/branding/_components/ThemeTab.tsx`

- Replace the **colors** `PageBuilderPointer` with a "Brand colors" section: one labeled `ColorField` per core token (primary, secondary, accent, background, foreground, card, muted, border) + a collapsible "Text colors" subgroup (primary/secondary/accent/card foregrounds).
- Order mirrors storefront flow (rule #5): primary → secondary → accent → background → foreground → card → muted → border.
- Each field reads from `branding.theme.<key>Color` and writes via the existing theme save (shallow-merge PUT; send only the changed key). Bilingual labels via next-intl (EN+AR) — no hardcoded strings (rule: Arabic-first).
- Keep a "Generate from Smart Palette" button that opens the existing SmartPaletteModal (now a starting-point generator).
- Leave the fonts + background pointers as-is for this PR.

### Task 5: Docs + CLAUDE.md parity

- Update the "Per-store visual configuration" canonical-owners table in `CLAUDE.md`: brand color tokens are now editable in **Branding → Brand colors** (Smart Palette is a generator that fills them); foregrounds honor explicit merchant values.
- Note in the plan/PR that fonts + per-section background remain Page-Builder-owned (follow-up).

## Verify

- `npm run db:generate` then `npx tsc --noEmit` for admin + shared + web.
- Prettier the changed set.
- Manual (preview): Branding shows 8 color fields; typing a hex applies; Smart Palette fills all fields; storefront uses the exact colors (foreground not auto-overridden); footer logo no longer black.

## Out of scope (follow-up)

- Restoring fonts + background editors in Branding (remove their pointers too).
- Exposing status/popover/input/ring tokens.
