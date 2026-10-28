# DAHAB-8

> Section: 2026-10-07 — Dahab template, builder Phase 3 pilot (branch `feat/template-dahab`)

Ruling DAHAB-8 — residual: `lib/serverTemplate.ts` imports every skin's homepage sections statically (the existing pattern, so the LCP hero renders on the server), which now includes Dahab's in every store's homepage bundle. Not measured in this pass. Cost if wrong: a few KB of unused JS on non-Dahab homepages until the map is code-split per skin.
