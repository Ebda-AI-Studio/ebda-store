# BARKOD studio shape drawings

- Source: https://barkod.studio/ (per-shape pages `https://barkod.studio/shape/<slug>`; the shape outlines are server-rendered SVG `<mask>` paths in the page HTML).
- Fetched: 2026-10-21.
- Permission: granted by the owner to Ahmad Sharaf, 2026-10-21; **written confirmation pending** (Ahmad will forward it; file it here when it arrives).
- Scope: Ebda receipts, packing slips, invoices and the order/billing emails (rendered to PNG: `apps/api/src/lib/barcode-png`, masks pre-rendered by `scripts/gen-barcode-masks.mjs`); no resale of the drawings as an asset pack, no other products.
- Used shapes (24 listed by Ahmad; the brief said 23): palm (`palm-tree`), horse, paw (`paw-print`), burger, cat, ghost, angry-shark, shark, gym-dude (`weightlifter`, mask id `gymdude`), heart (mask id `love`), dog, whale, bat, pizza, cloud, spider, big-cake (`birthday-cake`, mask id `bigcake`), lemon, ring, diamond, pineapple, french-fries, hot-dog, cookie. Ambiguities resolved by the site's own mask ids; confirm "gym dude" and "big cake" with Ahmad.
- Extraction: `scripts/extract-barkod-shapes.mjs` -> `packages/shared/src/barcode/shapes.generated.ts`. Paths are copied verbatim; only the barcode is ours (a real Code 128 encoder, since the site's bars are decorative).
- Credit line (kept in the generated file header and the admin picker): "Shape drawings by BARKOD studio (barkod.studio), used with permission."
