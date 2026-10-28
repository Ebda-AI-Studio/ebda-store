# BUILDER-PREVIEW-1

> Section: 2026-10-07 — Visual builder Phase 1 (branch `feat/builder-phase1`, BUILDER-\*)

Ruling BUILDER-PREVIEW-1 — preview = desktop + tablet + mobile (Ahmad 2026-10-07), REVERSING the 2026-06-22 "mobile only" call. Phase 1 encodes it in the data model (`VIEWPORTS`, `VIEWPORT_RANGES`: mobile < 768 / tablet 768–1023 / desktop ≥ 1024, preview widths 390 / 820 / 1280; per-viewport `hidden` and declared per-viewport settings; storefront `hideOnTablet` three-way classes). The legacy page-builder keeps its single 390px preview until the Phase 2 editor ships the switcher (the "no UI change in Phase 1" instruction); its code comment now records the reversal, and the gap matrix row 6 / finding 4 are marked decided. Cost if wrong: none to stored data — the switcher is UI-only.
