# BUILDER-MODEL-1

> Section: 2026-10-07 — Visual builder Phase 1 (branch `feat/builder-phase1`, BUILDER-\*)

Ruling BUILDER-MODEL-1 — the document follows the Shopify theme-editor model before anything is persisted: template = ordered sections; sections hold ordered blocks (hero slides are `slide` blocks); header/footer are section groups; every section/block type declares a bilingual settings schema that will generate the editor panel; global theme settings are a schema typed against `StoreTheme` (values stay on the store theme, single writer = theme PUT); add-section presets; data pickers bind by reference only. Evidence: Ahmad's direction, 2026-10-07; `tests/unit/builder-page-definition.test.ts` asserts every field the layout API stores has a descriptor and none is phantom, and every preset validates. Cost if wrong: renaming a v1 field later needs a `schemaVersion: 2` migration over stored revisions.
