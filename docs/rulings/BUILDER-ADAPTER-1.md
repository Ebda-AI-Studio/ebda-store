# BUILDER-ADAPTER-1

> Section: 2026-10-07 — Visual builder Phase 1 (branch `feat/builder-phase1`, BUILDER-\*)

Ruling BUILDER-ADAPTER-1 — accepted non-round-trips of the layout adapter: (a) a legacy `hideOnTablet` explicitly equal to `hideOnDesktop` normalises away (it is the legacy two-way mode either way); (b) a document that REMOVES a required section (hero, categories, carousels, testimonials) projects as that section disabled, not as the packaged default; (c) a hidden block (slide) is left out of the `layout_settings` projection (the legacy shape has no per-slide flag) while the document keeps it. Everything else round-trips exactly both ways (golden fixtures × 5 templates, 500 generated layouts). Cost if wrong: a legacy reader of `layout_settings` sees a hidden slide as deleted — the storefront renders from the same projection, so what it shows is consistent.
