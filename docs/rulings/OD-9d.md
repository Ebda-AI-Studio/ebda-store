# OD-9d

> Section: 2026-10-01 — owner decisions 6 / 7 / 9 (branch `fix/owner-decisions-6-7-9`)

**Ruling OD-9d — the new position is the platform default; demo-store keeps the legacy corner through
per-store DATA (`StoreTheme.saleBadgeLegacyCorner = true`), set by a one-off script BEFORE deploy.**
Owner, 2026-09-30: every store except demo-store gets the top corner; demo-store must look exactly as
now. The code never branches on a slug; it reads the flag. `scripts/set-sale-badge-legacy-corner.mjs`
writes it through the live theme PUT, which shallow-merges an unknown key and busts the store caches,
so it can run before the code that reads it ships. Proven: every surface with the flag set is
pixel-identical to origin/main (screenshot diff = 0). Cost if wrong: if the script is not run (or its
edge-cache check not waited for) before deploy, demo-store shows the top-corner badge until the flag
lands — the run order in the PR body is the control.
