# LOOKS-6

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-6 — `DEFAULT_THEME` does NOT gain `density` / `imageRatio` / `motion`; the keys stay optional and are set only by `lookTheme()`, and `lookCssVars` / `themeToCssVars` emit the look variables only when `lookId` names a registered look (gated on the look, not on whether a key is present). Evidence: the Phase S finish line is that every legacy store (look = null) renders byte-identical; a stray `density` or `headingFont` on a legacy store therefore emits nothing, and a look store whose merchant cleared a key still gets the look's font (`tests/unit/looks-css-vars.test.ts`). Cost if wrong: a later need for global defaults adds them then.
