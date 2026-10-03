# Test fixtures

## `amelia-aurum-catalogue.csv`

**SYNTHETIC. Not Amelia Aurum's real catalogue.** Invented products, prices, SKUs and image URLs
(the image host `cdn.example-amelia-aurum.test` does not exist) in the Shopify product-CSV layout, with
extra `Title (AR)` / `Body (HTML) (AR)` columns for the Arabic names. Every product is tagged
`synthetic-fixture`. It stands in until the merchant's real export arrives; the real file imports
through the same path (`POST /stores/:storeId/bulk/import`, or `node scripts/ebda-seed-amelia.mjs --csv <file>`).

Used by `tests/unit/csv-import.test.ts` and `tests/integration/amelia-catalogue-import.test.ts`.
