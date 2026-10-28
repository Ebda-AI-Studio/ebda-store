# BUILDER2-CHROME-1

> Section: 2026-10-07 — Visual builder Phase 2: the editor (branch `feat/builder-phase2`, BUILDER2-\*)

Ruling BUILDER2-CHROME-1 — `/stores/:id/builder` is exempt from the "every store page reaches `<AdminLayout>`" guard (`apps/admin/src/app/__tests__/admin-chrome-early-return.test.ts`, `FULL_SCREEN_EDITORS`, with a rot check). Evidence: the brief asks for a Shopify-theme-editor-style editor, which is full-screen by design; it carries its own top bar with the open-door mark linking back to the store dashboard. The guard's purpose (chrome vanishing mid-load on normal pages) still applies to every other page. Cost if wrong: a merchant inside the builder has one click back instead of the sidebar.
