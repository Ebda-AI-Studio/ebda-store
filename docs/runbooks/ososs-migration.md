# OSOSS → Ebda Store Migration Runbook

How to migrate a merchant from **OSOSS** (the Egypt retail-ERP at ososs.com, formerly **zfloos.com** — its S3 bucket is `zfloos-production-storage`) onto Ebda Store. First used for **demo-store** (665 products).

OSOSS is the competitor platform Ebda Store displaces, so its product export is a recurring migration source. This runbook + the native variant import (below) make it a one-file job.

---

## 1. What the OSOSS export looks like

The merchant exports products as XLSX. Columns are OSOSS-internal, e.g.:

- `id, barcode, sku, slug, parent_sku, en_name, ar_name, en_description, ar_description, en_main_category, ar_main_category, price, type, oa_XXXX_size, image, quantity_on_hand, status, slug_url …`
- **`type`** is `Configurable` (a parent that groups variants) or `Inventory` (a simple/standalone product or a variant child).
- **`parent_sku`** links a variant child to its `Configurable` parent (parent's `sku`).
- **`oa_<id>_size`** (e.g. `oa_2953_size`) is the variant axis — OSOSS's dynamic "size" attribute. The numeric id differs per store; it's whichever `oa_*` column holds the size/option value.
- **`image`** holds one or more comma-separated S3 URLs on `zfloos-production-storage.s3.eu-central-1.amazonaws.com`. Configurable parents usually carry the main image; children usually don't.

A typical catalog is variant-heavy (demo-store: 154 configurable parents + 462 size children + 49 standalone).

---

## 2. Images — pull them off OSOSS S3 NOW

The S3 URLs are public **while the merchant still pays OSOSS** and will likely die after they leave. Two facts:

- Ebda Store's importer **ingests images by URL** — it downloads each `images` URL server-side into Cloudflare R2 at import time. So the import file can point straight at the live OSOSS S3 URLs and Ebda Store pulls them in.
- **Archive them anyway as insurance.** For demo-store: `~/Downloads/demo-store-migration/images/` (337 files, named by sku) + `image-manifest.csv` (sku → url → local file). If S3 is already dead at import time, re-host the archived files to R2 and swap the `images` column to the new URLs before importing.

Convert step (per merchant): read the OSOSS xlsx, emit `demo-store-converted.json` (`{ base, variants }`) and the combined Ebda Store sheet; the scripts live in `~/Downloads/demo-store-migration/`.

---

## 3. The Ebda Store import sheet contract (native variant import)

Ebda Store's bulk importer (`apps/api/src/services/bulk.service.ts`, route `POST /stores/:id/bulk/import-xlsx`) accepts the standard product columns **plus** these variant columns. A row with a non-empty `parentSku` is a **variant** of the product whose `sku` equals it.

| Column                         | Meaning                                                                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (all existing columns)         | `name, nameAr, slug, description, descriptionAr, price, compareAtPrice, costPrice, sku, barcode, inventory, lowStockThreshold, trackInventory, weight, status, featured, isNew, categories, tags, images, meta*` |
| `parentSku`                    | Empty → **base product**. Non-empty → **variant** of the base product with this `sku`.                                                                                                                           |
| `option1Name` / `option1Value` | First variant axis, e.g. `Size` / `1 Kg`. **Required on variant rows.**                                                                                                                                          |
| `option2Name` / `option2Value` | Optional 2nd axis.                                                                                                                                                                                               |
| `option3Name` / `option3Value` | Optional 3rd axis (Ebda Store max = 3).                                                                                                                                                                                 |

Rules:

- **Base row:** full product fields, `parentSku` empty. Its `price` is the "from" price; leave its `inventory` 0 (stock lives on the variants).
- **Variant row:** `parentSku` set; uses `sku` / `barcode` / `price` / `compareAtPrice` / `costPrice` / `inventory` / `weight` for the variant, and the first URL in `images` for the variant image. `name` / `description` / `categories` etc. are ignored (inherited from the parent).
- A base product with ≥1 variant row is flagged `hasVariants=true` automatically; variant `title` is the option values joined by `" / "`.
- The variant's `parentSku` must resolve to a base product **in the same file** or **already in the store**.
- `updateExisting=true` + an existing parent that already has variants → its options/variants are **deleted and rebuilt** from the file (same replace-semantics as categories/images). `updateExisting=false` + existing parent → the row fails.
- **Prices are EGP in both the XLSX and CSV paths** (2026-10: the converter ×100 → piastres; a third decimal is rejected as ambiguous). Legacy EGP-era note: this runbook predates the Ebda money change; convert any EGP sheet to EGP amounts before upload and use `/bulk/import-preview` to check it.
- Backward compatible: a sheet without the variant columns imports exactly as before.

Mapping OSOSS → these columns: `en_name→name`, `ar_name→nameAr`, `price→price`, `sku→sku` (generate from `barcode`/`id` when blank), `barcode→barcode`, `quantity_on_hand→inventory`, `en_main_category→categories`, `image→images`; for a child row set `parentSku=parent_sku`, `option1Name=Size`, `option1Value=<oa_*_size>`.

---

## 4. Admin steps

1. Provision the store in Ebda Store admin (get its store id).
2. Settings → **Bulk Operations** → download the import template (now includes the variant columns + a sample variant row) to confirm the shape.
3. Upload the converted XLSX via the **Bulk Import** wizard (`import-xlsx`). It enqueues an async job; poll until complete.
4. Verify the result: `created` = number of base products, `variantsCreated` = number of variants, `failed` = 0. Investigate any failures (the result lists per-row errors).
5. Open 2–3 configurable products on the storefront and confirm the **size dropdown** shows the right sizes/prices/stock and images render from R2.

For demo-store specifically: expect **203 products + 462 variants + 154 with variants, 0 failed** (validated against the real export).

---

## 5. Post-import AI cleanup

OSOSS exports often have Arabic text sitting in the `en_*` fields (messy bilingual data). Ebda Store's **AI autopilot** (bidirectional EN↔AR, default ON) fills/cleans the empty-or-mismatched language fields after import. Run it, then re-check a sample. Manual edits always win (per-field provenance).

---

## 6. Gotchas

- **Don't rely on OSOSS S3 staying up** — archive images before the merchant cancels OSOSS.
- **The `oa_*_size` column id varies per store** — find whichever `oa_*` column holds the option values.
- **Naive CSV newlines:** product descriptions can contain embedded newlines; the importer parses quoted multi-line fields correctly (`splitCsvRecords`), but if you hand-edit the CSV keep multi-line values quoted.
- **SKU is unique per store** — the converter auto-generates a SKU (`barcode` or `PB-<id>`) for rows missing one.
