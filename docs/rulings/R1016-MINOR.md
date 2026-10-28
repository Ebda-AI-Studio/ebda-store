# R1016-MINOR

> Section: 2026-10-16 — review of `fix/ahmad-decisions-1016` (R1016-\*)

Ruling R1016-MINOR — Images resize has a 10s deadline (`IMAGES_DEADLINE_MS`), a timeout falls the whole set back (tested); the post-enable check verifies `maskableIcon` is 512×512 too; `withImagesBinding` adds the binding after every `ai` line (top level and each `env.*`, same indent; the smoke strips all of them); the changelog names the Modern template's gold default; the demo notice reads "الطلبات مقفولة" (source + pin together). Cost if wrong: an Images call slower than 10s on a healthy binding falls back to pass-through for that upload.
