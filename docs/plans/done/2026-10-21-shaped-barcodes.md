# Shaped, scannable order barcodes (2026-10-21)

Finish line: every receipt/invoice barcode is a REAL Code 128 of the order number, optionally clipped into a BARKOD shape; every shape decodes back to the number in a test; merchants pick the shape per store.

1. **Data + provenance**: 24 shape outlines extracted verbatim from barkod.studio (`shapes.generated.ts`, `docs/third-party/barkod-studio.md`).
2. **Generator** (`packages/shared/src/barcode/`): own Code 128 B/C encoder (~100 lines, no dep; a registry lib buys nothing for one symbology), `renderBarcodeSvg({value, shape})` -> SVG string: decorative bars masked by the shape, full-width scan zone (48u) at the bottom, 10-module quiet zones, human-readable number. Colour = `currentColor` (ink on paper, never orange).
3. **Scan gate** (`tests/unit/shaped-barcode-decode.test.ts`): every shape x {short numeric, `ORD-` style, long} rasterised with `@resvg/resvg-js` (dev) and decoded with `zxing-wasm` (dev); must equal the input. Failing shapes are excluded and listed in the report.
4. **Setting** `settings.receiptBarcodeShape` (`plain` default | shape | `off`): shared Zod enum, checked in the store `addSettingsIssues` edge, added to the public settings allowlist; admin picker with live previews, settings save already busts the store cache.
5. **Surfaces**: storefront `ReceiptPrinter` (replaces the fake `Barcode.tsx`), API invoice HTML (`invoice.service.ts`). No packing-slip view exists in the repo today (reported, not invented). `<bdi dir="ltr">`, print CSS keeps ink.
6. **Ebda billing (coordinator addition)**: merchant billing payment-success screen reuses the receipt-printer animation, Ebda palette, PALM shape (Ahmad correction, not ghost) of the payment/invoice number, ar/en, static under reduced motion; palm on the billing invoice print.

Not changing: order numbers, DB schema (settings is a JSON bag), existing receipt copy. Done = typecheck + lint + full unit suite green, decode gate green, report in `.superpowers/barcode-report.md`.
