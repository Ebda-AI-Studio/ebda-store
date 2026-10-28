# BARCODE-1

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling BARCODE-1 - supersedes B0-3: the order barcode is a REAL Code 128 (own ~60-line B/C encoder in `packages/shared/src/barcode`, no dependency), optionally clipped into one of 24 BARKOD studio shapes with a clean 48-unit full-width scan zone. Evidence: `tests/unit/shaped-barcode-decode.test.ts` rasterises every shape x 4 order numbers and decodes with zxing-wasm (all equal the input; blanked-bars and wrong-number controls fail as they should). Cost if wrong: a shape that mis-scans on some device prints a bad barcode; the store can pick `plain` or `off`.
