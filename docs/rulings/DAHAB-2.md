# DAHAB-2

> Section: 2026-10-07 — Dahab template, builder Phase 3 pilot (branch `feat/template-dahab`)

Ruling DAHAB-2 — Dahab-only presentation branches on the skin (`pack === 'dahab'` / `templateId === 'dahab'`) at four seams — the platform card and carousel hand over to Dahab's, `ProductDetailClient` renders `DahabProductDetail` with the same computed data and handlers, the collection page gets a 3/4-per-row control and a night filter panel — while every commerce rule (pricing, variants, stock, backorder, add to cart, pixels) stays in the shared code. Evidence: the 5 legacy templates' homepage characterization snapshots are unchanged; `VariantSelector` gained an `appearance` prop whose default renders byte-identical classes. Cost if wrong: the product-page improvements (zoom, accordions, pinned buy bar, swatches) reach other skins only when ported.
