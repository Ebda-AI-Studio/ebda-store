# BUILDER2-CANVAS-1

> Section: 2026-10-07 — Visual builder Phase 2: the editor (branch `feat/builder-phase2`, BUILDER2-\*)

Ruling BUILDER2-CANVAS-1 — the canvas trusts exactly the storefront's CSP `frame-ancestors` origins (same env var `STOREFRONT_FRAME_ANCESTORS`, same defaults) AND `event.source === window.parent`; the editor trusts only the storefront origin it framed AND that iframe's window. Evidence: `tests/unit/builder-preview-canvas.test.tsx` pins the origin list to `next.config.js`; E2E "a message from a foreign origin is ignored" with a positive control proving the hostile message arrives; dropping the editor-side check turns that test red (`PWNED` reaches the field). Cost if wrong: a framed third-party page could inject text edits into an open editor (still a DRAFT; publishing is a separate explicit click).
