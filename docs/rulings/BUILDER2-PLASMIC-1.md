# BUILDER2-PLASMIC-1

> Section: 2026-10-07 — Visual builder Phase 2: the editor (branch `feat/builder-phase2`, BUILDER2-\*)

Ruling BUILDER2-PLASMIC-1 — no Plasmic code adopted in Phase 2, so no `THIRD_PARTY_NOTICES.md` yet (BUILDER-LICENSE-1 still governs any future copy). Evidence: `@plasmicapp/host`'s `canvas-host` speaks Plasmic Studio's own wire protocol and expects its registration runtime; adapting it would have cost more than the ~200-line overlay (`apps/web/src/builder/preview/EditorOverlay.tsx`) plus a 60-line Zod protocol, and `react-web`/loaders render Plasmic-hosted projects, not Ebda's registry. Webstudio and Plasmic `platform/` were studied for UX only (content/design modes, navigator tree with visibility toggles, breakpoint bar, insert panel with previews). Cost if wrong: a later need for nested slots/canvas drag-and-drop may make `canvas-host` worth adapting; that copy would then need the MIT header and notices entry.
