# Barcode field on the product and variant forms (Amelia QA, scan page could never find a product)

Status: built in this PR.

## Finding

The API already stores, validates and de-duplicates `barcode` (BARCODE-1: `parseBarcodeOrThrow`, `assertBarcodeAvailable`, partial uniques from
migration 20261107000270, variants checked store-wide). The admin product forms never sent it, and the edit page only displayed it. A merchant with
`inventory.barcode` off, or who wanted their supplier's EAN, had no way to set one, so the Scan page ("Products must have a barcode set to be found")
could not find anything. No schema or migration change is needed (column + uniqueness exist on Postgres and the D1/DO path through the same service).

## Build

- `barcodeField(typed, loaded, intent)` in `apps/admin/src/lib/product-payload.ts`: create omits empty (API auto-generates), update omits unchanged
  (never clobbers an auto-generated code), emptied sends null, changed sends the text.
- Barcode input on `products/new`, `products/[id]/edit`, and each row of `SimpleVariantsForm`.
- `BARCODE_IN_USE` / `BARCODE_INVALID` Egyptian-Arabic + English copy in `lib/error-messages.ts`; the variant save surfaces them instead of a bare partial-failure toast.
- Help article (ar + en) states the field.

## Cost if wrong

A wrong update payload would clear or overwrite a merchant's printed barcode and break labels already on shelves; hence omit-when-unchanged and the tests.
