# SP-3

> Section: 2026-11-03 - editor Theme tiers and per-device spacing (SP-\*)

Ruling SP-3 - hero Top / Bottom spacing is an outer margin on the hero wrapper; the hero keeps its aspect-driven height, and an untouched hero adds no class. Evidence: `sectionMarginClasses` returns an empty string when nothing is set; `editor-matrix` shows `section:hero|paddingTop` wired on every skin. Cost if wrong: the hero margin can collapse with a neighbouring section's padding, so the visible gap is smaller than the chosen step.
