# EDITOR-LIVE-2

> Section: 2026-10-07 — Visual builder canvas never became interactive on the hosted preview (branch `fix/editor-live-preview`)

Ruling EDITOR-LIVE-2 — accepted residual: inline (double-click) editing in the canvas covers SECTION text settings only; block text (hero slide headlines, badges) is edited from the settings panel. Evidence: `inlineSettingFor` resolves keys against the section's settings and the overlay never sends `blockId`. Cost if wrong: a merchant double-clicking a hero headline sees nothing happen and may read it as "editing is broken" — follow-up, not part of this P0.
