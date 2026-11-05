# Editor: simplified Theme panel + per-section, per-device spacing (2026-11-03)

Source: `Ebda-AI-Studio/business/ebda/audits/2026-11-03-admin-editor-impeccable-audit.md` (2.10 E-\*, 3, 4). Approved by Ahmad.

## Finish line

- Must work: Theme panel in 3 tiers (presets + feel + 3 colours / grouped / advanced) with `density` exposed; per-section top/bottom spacing at the top of Design on every page, 6 steps (new `xxloose`), optional per-device (desktop/tablet/mobile) with "same on all devices" default ON, hero included (outer margin); the 3 mobile-editor bugs; the other E-\* findings.
- Exercised: adapter round trip, descriptor parity/validate, `sectionSpacingClasses` output, SettingsPanel device switch, Theme panel tiers, hero/new-arrivals canvas states, header lockup.
- Must NOT change: a document with no per-device keys renders byte-identical; THEME-DRAFT-1 / VE-4 draft/publish semantics; no new document schema (per-device values live in `responsive.<vp>.settings`).
- Done: touched + related vitest green, typecheck of shared/admin/web green, repo guard tests green, blast-radius stated.

## Tasks (TDD for logic)

1. Shared model: `xxloose` in `PADDING`, layout-schema, `SectionPaddingMaxWidthVisibility`; legacy keys `paddingTopTablet|Mobile`, `paddingBottomTablet|Mobile`; adapter maps them <-> `responsive.<vp>.settings` (all sections); registry `responsive.settings` auto-declared for spacing; hero un-retires paddingTop/Bottom; shared `SECTION_SPACING_PX` + `resolveSpacing` (device -> base -> preset -> baseline). Tests: adapter round trip (desktop-only doc byte-identical, per-device doc), descriptor parity, validate accepts/rejects, resolution order.
2. Storefront: `sectionSpacingClasses` per-device classes (static literal classes, no marker when an axis is per-device), `xxloose`, hero outer margin (`sectionMarginClasses`). Tests: unset = old output exactly; mobile != desktop snapshot; class table parity with shared px table.
3. Admin spacing UI: `SectionSpacingField` at top of Design, 6-step segmented + px readout, same-on-all toggle, device tabs tied to the editor device radio, dot on differing devices. Test: device switch edits the matching key; toggle ON clears overrides.
4. Theme panel: tiers + presets + density/radius/font segmented + 3 colour swatches + search + "reset all"; advanced collapsed. Tests for tiers/search/preset patch (draft semantics: only changed keys saved).
5. Canvas bugs + E-\*: header lockup width + chip outside the section; hero placeholder "ضيف صورة"; empty product sections hint with add-products link; device default by window width (E-4); rename الستايل (E-5); history empty copy (E-6); tree row targets (E-11); Design tab typography/dividers behind "متقدم" (E-3); header tree row.
6. Docs parity: merchant help/editor docs mentioning Theme/spacing.

## Rulings

Ruling SP-1 - per-device spacing is stored in `responsive.<vp>.settings.paddingTop|Bottom` (desktop/base stays in `settings`); legacy bridge keys `paddingTopTablet|Mobile`. No document-schema change. Cost if wrong: a rename needs a data migration of saved documents.
Ruling SP-2 - an axis customised per device is not scaled by the look's `--space-unit` (same as an explicit preset, LOOKS-3). Cost if wrong: airy looks do not scale a per-device value.
Ruling SP-3 - hero spacing is outer margin; the hero keeps its aspect-driven height. Cost if wrong: hero margin collapses with neighbours' padding.
