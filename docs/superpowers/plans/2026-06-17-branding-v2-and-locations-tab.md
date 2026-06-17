# Branding v2 (primary+secondary → derive rest, 2-color background, drop Smart Palette) + Locations tab + footer

**Goal (Ahmad, 2026-06-17):** The #256 8-color editor is "too much". Reduce to **Primary + Secondary** as the only real inputs; auto-generate Accent + Text + Card + Muted + Border from them (each overridable). Background is **two alternating colors** (wadyaljuz/pecannbee use 2 so the page isn't uniform), not one. **Remove the Smart Palette** (he finds it useless) — fold its derive-from-seeds brain inline. Also: surface **Locations** as a tab in the branding tab bar (it's a standalone page today), and show store branches in the storefront footer.

**Architecture:** Keep the storefront rendering from STORED theme values (safe for wadyaljuz/pecannbee which have explicit colors) — do the derivation in the ADMIN (fill the derived keys) + add two explicit background keys consumed by the existing `--bg-page`/`--bg-section-alt` alternation. No risky shared-render rewrite.

---

## Part 1 — Branding colors v2 (ThemeTab)

### Shared (`packages/shared`)

- `deriveCoreBrandTokens` (color.ts, added in #256): re-tune to seed from **primary + secondary** (currently primary+accent+neutral). Output the full set as HSL triplets: `accentColor, foregroundColor, cardColor, cardForeground, mutedColor, mutedForeground, borderColor, primaryForeground, secondaryForeground, accentForeground` **plus `bgPage` + `bgSectionAlt`** (two page backgrounds: a near-white tint + a subtly deeper tint derived from the palette, distinct enough to read as alternating sections but both light).
- `StoreTheme` type (store-theme.ts): add optional `bgPage?: string` and `bgSectionAlt?: string` (HSL triplets).
- `resolveBackgroundPreset` (store-theme.ts): **prefer explicit `bgPage`/`bgSectionAlt`** when set → `{ bgPage, bgSectionAlt }`; else fall back to the existing preset logic (backward compatible — stores on a preset are unchanged). `themeToCssVars` already maps these to `--bg-page`/`--bg-section-alt`; no storefront change needed.

### Admin (`apps/admin` ThemeTab.tsx)

- Top: **Primary** + **Secondary** ColorFields (the two seeds), prominent.
- **Page backgrounds**: two ColorFields — "Background 1" (`bgPage`) + "Background 2" (`bgSectionAlt`), with a one-line hint "sections alternate between these two so the page isn't uniform". Smart-defaulted from the derive.
- Button **"Regenerate from Primary & Secondary"** → runs `deriveCoreBrandTokens(primary, secondary)` and fills accent/foreground/card/muted/border + bg1/bg2 + the \*Foreground keys into branding.theme (patchTheme each). Also auto-fill on first load when primary+secondary set but derived keys empty.
- **Advanced colors** collapsible (default collapsed): Accent, Text (foreground), Card, Muted, Border + the text-on-color foregrounds (primary/secondary/accent/card foreground) — each a ColorField; editing = manual override. A small "reset to auto" per field clears the key back to derived (optional; at minimum editing overrides).
- **Remove** the `SmartPaletteModal` import, the `paletteOpen` state, the "✨ Smart Palette" button, and the `<SmartPaletteModal>` block. Keep blog toggle + footer-logo section + BrandPreview.
- Admin local `StoreTheme` type (branding/\_components/types.ts): add `bgPage?`, `bgSectionAlt?`.
- i18n (en.json/ar.json `branding.theme.brandColors.*` + a new `backgrounds.*`): add keys for the 2 backgrounds, the regenerate button, advanced-section heading. Bilingual, no hardcoded strings.

### Out of scope (this PR)

- The Smart Palette modal in the Page Builder is separate — leave it; only remove it from the Branding ThemeTab. (Follow-up: decide whether to retire it platform-wide.)

## Part 2 — Locations as a branding tab + footer

### Admin

- `BrandingTabId` (types.ts): add `'locations'`. `BrandingTabs.tsx`: push `{ id: 'locations', key: 'locations' }` (place it where Ahmad listed it — first, before Branding, or last; default: last, after Social, to avoid reordering muscle memory — confirm in review). i18n `branding.tabs.locations`.
- Extract the locations CRUD UI from `apps/admin/src/app/stores/[id]/locations/page.tsx` into a reusable `LocationsTab`/`LocationsManager` component; render it in the branding `page.tsx` panel when `activeTab==='locations'`. Keep the standalone `/locations` route working (it can render the same component) so existing links don't break.

### Storefront footer

- Check what #257 added (a nav link). Add an actual **Branches** column to the footer (all 5 themes share `FooterProps`): each location = name + address (linked to `googleMapsUrl` when present) + optional phone, under a "Branches"/"فروعنا" heading. Add `locations?` to `FooterProps`, thread it from the footer data source (public GET locations endpoint from #252), increment `totalColumns`, conditionally render when locations exist. RTL-safe, bilingual.

## Verify

- `npm run db:generate`; `npx tsc --noEmit` for shared + admin + web (all clean).
- Prettier changed set.
- Manual (preview): Branding shows Primary+Secondary + 2 backgrounds + Advanced collapsible; Regenerate fills them; storefront sections alternate between the 2 bgs; Locations is a branding tab; footer shows branches.
