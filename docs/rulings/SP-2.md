# SP-2

> Section: 2026-11-03 - editor Theme tiers and per-device spacing (SP-\*)

Ruling SP-2 - an axis that carries a tablet or mobile value is emitted per device as literal classes and is not scaled by the look's `--space-unit`, exactly like an explicit preset (LOOKS-3). Evidence: `sectionSpacingClasses` adds `sp-top-default` / `sp-bottom-default` only to an axis with no value anywhere (`tests/unit/section-spacing-device.test.ts`). Cost if wrong: an airy look does not scale a merchant's per-device value.
