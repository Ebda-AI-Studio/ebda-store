# DRM-2

> Section: Backlog batch d-routes-mcp (2026-10-01)

**Ruling DRM-2 — receipt uploads keep the shared 2000px ceiling (issue 1049, declined with a
measurement).** The finding was reasoning-only ("may degrade OCR"), so it was measured on
2026-10-01: a synthetic 3024x4032 phone-style receipt photo (receipt ~36% of the frame width, 22
line items with 3-decimal EGP amounts in ~22px type, then blurred σ1.6, rotated 3°, JPEG q70) and
its `fit: inside` 2000px downscale were each sent 3 times through the exact production OCR prompt
and model (`gemini-flash-lite-latest`, JSON mode). All 6 runs returned the exact total (154.875)
and 22/22 exact line totals. A separate higher OCR ceiling would store ~2.5x the bytes for no
measured gain. Cost if wrong: a real receipt with smaller or fainter print than the fixture (a
long thermal till roll photographed whole) reads worse at 2000px, which would show as more
null/incorrect `total` values in expense drafts — re-measure with such a photo before raising the
ceiling.
