# SP-1

> Section: 2026-11-03 - editor Theme tiers and per-device spacing (SP-\*)

Ruling SP-1 - per-device section spacing is stored in `responsive.<tablet|mobile>.settings.paddingTop|paddingBottom` (desktop and base stay in `settings`); the legacy bridge keys are `paddingTopTablet|Mobile`, `paddingBottomTablet|Mobile`; six steps, `xxloose` added; resolution is device, then base, then preset, then baseline. Evidence: `responsive.<vp>.settings` is already a free record in `sectionNodeSchema`, so no document-schema change; `tests/unit/builder-section-spacing.test.ts` pins the adapter round trip and the resolution order. Cost if wrong: renaming the keys needs a data migration of every saved document that set a per-device value.
