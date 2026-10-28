# BUILDER2-PREVIEW-DATA-1

> Section: 2026-10-07 — Visual builder Phase 2: the editor (branch `feat/builder-phase2`, BUILDER2-\*)

Ruling BUILDER2-PREVIEW-DATA-1 — inside the canvas the DRAFT drives the page's data fetches and chrome (`definitionToLayout(draft)`), so a carousel added in the editor loads its own products; the editor reloads the canvas after an autosave that changed a data-bearing setting (product source, category, manual products, limits, review filters). Cost if wrong: one autosave interval (1.2 s) of stale product tiles after such an edit.
