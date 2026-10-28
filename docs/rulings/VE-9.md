# VE-9

> Section: 2026-10-22 — Visual editor (VE-\*)

Ruling VE-9 (Task 7, 2026-10-22) — the theme pane has no `dividers` control. Evidence: the standalone dividers page was merged into the page builder as per-section dividers (commit `a2d20e12`), the platform-wide card was deleted 2026-05-20 ("Per-section dividers now live inside each SectionCard"), and `ThemeSettingsPanel` only showed a "classic page builder" link for it. The storefront still honours a stored `theme.dividers`. Cost if wrong: a merchant who set a platform-wide divider before 2026-05 cannot edit it from the editor; per-section dividers override it.
