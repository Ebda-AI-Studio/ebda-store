# SP4 task 8: Amelia Aurum local run

Evidence that a catalogue CSV imports and the store serves it at its host. **The data is the synthetic fixture**
(`tests/fixtures/amelia-aurum-catalogue.csv`), not Amelia Aurum's real catalogue; the real export imports the same way.

Setup (local only): Postgres 16 db `ebda_amelia` migrated with `prisma migrate deploy`, Redis via `redis-server --daemonize yes`,
API via `PORT=4000 npm run dev:api`.

## Seed

```
DATABASE_URL=postgresql://test:test@localhost:5432/ebda_amelia npx tsx scripts/ebda-seed-amelia.mjs
```

Creates store `amelia` (name Amelia Aurum, EGP, ar default, plan `enterprise` pending SP5's plans engine) and imports through
`importCsvToPlatformCsv` -> `BulkService.importProducts` inside `runInStoreScope`, the same call the Inngest job makes.

```
csv format: shopify   total rows: 33   created: 13   variantsCreated: 20   failed: 0   errors: []
```

(29 source lines: image-only rows fold into the product gallery, each variant line becomes one variant row.)

## Public API by host

The storefront forwards the visitor's host to the API as `x-store-domain` (the API's own `Host` is `api.*`), so that is the header the
resolver reads (`apps/api/src/lib/store-host.ts`).

```
curl -H 'x-store-domain: amelia.ebda.app' localhost:4000/api/v1/public/products?limit=50
  -> 200, meta.total = 12   (13 imported; the draft "Silver Chain Bracelet" is correctly not public)

curl -H 'x-store-domain: rival.ebda.app'  localhost:4000/api/v1/public/products?limit=50
  -> 200, products: [], meta.total = 0
curl -H 'x-store-domain: rival.ebda.app'  localhost:4000/api/v1/public/products/solitaire-ring-18k
  -> 404 NOT_FOUND
```

Sample products (prices are integer piastres):

| slug                    | name                          | nameAr                             | price (piastres) | EGP       |
| ----------------------- | ----------------------------- | ---------------------------------- | ---------------- | --------- |
| hoop-earrings-18k       | Hoop Earrings 18K Gold        | حلق دائري ذهب عيار 18              | 485000           | 4,850.00  |
| name-chain-necklace-21k | Arabic Name Necklace 21K Gold | قلادة اسم بالخط العربي ذهب عيار 21 | 1450000          | 14,500.00 |
| solitaire-ring-18k      | Solitaire Ring 18K Gold       | خاتم سوليتير ذهب عيار 18           | 1875000          | 18,750.00 |

`GET /public/products/solitaire-ring-18k` (host `amelia.ebda.app`): option `Size`, variants
`AA-SOL18-6..9` at 1875000 / 1885000 / 1895000 / 1905000 piastres with stock 6 / 7 / 8 / 9, and two remote images
(`https://cdn.example-amelia-aurum.test/img/solitaire-ring-18k-{1,2}.jpg`, kept as source URLs; R2 ingestion is a later pass).

## Defect found on the way

`bulk-import.ts` ran the whole import inside `runInTenantContext` (one outer transaction). Categories/tags created up front were
uncommitted when `importProducts`' own `withMoneyTx` batches linked them, so any import introducing a new category failed with a
`product_categories_category_id_fkey` violation (13 of 13 products failed here before the fix). The job now uses `runInStoreScope`.
