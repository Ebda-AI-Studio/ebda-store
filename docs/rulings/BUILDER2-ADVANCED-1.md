# BUILDER2-ADVANCED-1

> Section: 2026-10-07 — Visual builder Phase 2: the editor (branch `feat/builder-phase2`, BUILDER2-\*)

Ruling BUILDER2-ADVANCED-1 — the per-section typography and divider compound editors are not ported into the generated panel; those two descriptors render a link to the classic page builder (which stays live), and every other descriptor type is generated. Evidence: they are large bespoke editors (`SectionTypographyBlock`, `SectionDividersBlock`) with global-zone fallbacks; porting them is its own task. Cost if wrong: a merchant edits typography in a second screen until they are ported.
