# VE-8

> Section: 2026-10-22 — Visual editor (VE-\*)

Ruling VE-8 (Task 6, 2026-10-22) — the per-section typography and dividers editors are EXTRACTED to `apps/admin/src/components/section-design/` and used by both the form page builder and the visual editor, instead of being copied. Evidence: the two blocks are ~350 lines with global-zone fallbacks; a copy would drift for the weeks both pages live, and Task 12 deletes only the page. The page-builder behaviour and messages are unchanged. Cost if wrong: a change to the shared block touches the page builder too, until Task 12 removes it.
