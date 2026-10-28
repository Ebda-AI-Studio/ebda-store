# R-EBDA-COPY-11

> Section: 2026-10-07 — Marketing copy and design (R-EBDA-COPY-\*)

Ruling R-EBDA-COPY-11 (superseded 2026-10-07: the room-scenes section and `compose.mjs` were removed in PR 37, Ahmad did not like them) — the room scenes are composited OFFLINE (`scripts/scenes/compose.mjs`: Chromium renders the capture onto a real laptop screen with a matrix3d homography, or a CSS phone with 3D rotation, shadow and screen light, onto CC0 room photos) and shipped as flat AVIF/WebP, instead of transforming live DOM over a photo at runtime. Evidence: identical look, zero runtime layout/3D cost, works without JS. Cost if wrong: re-run the script whenever the captures change (run it after `capture:stores`).
