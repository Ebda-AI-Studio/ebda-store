# OSOSS → FWB Native Variant Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend FWB's bulk product importer so a single CSV/XLSX upload can create products _with their variants_ (size/color/etc.), enabling one-file migrations from OSOSS (formerly zfloos) — starting with the pecannbee onboarding (665 products, 154 with size variants).

**Architecture:** Add three optional column groups to the existing import sheet — `parentSku`, `option{1,2,3}Name`, `option{1,2,3}Value`. Rows with a non-empty `parentSku` are parsed as _variant rows_ of the base product whose `sku` matches. The importer groups variant rows under their parent and, inside the existing 50-row batch transaction, creates `ProductOption` + `ProductOptionValue` + `ProductVariant` + `ProductVariantOption` rows directly against the transaction client (NOT via `variant.service`, which would break atomicity), and sets `Product.hasVariants = true` in the same tx. Files without the new columns import exactly as before (zero behavior change).

**Tech Stack:** Express + TypeScript (apps/api), Prisma (packages/database, Neon Postgres), ExcelJS (xlsx parse), csv-parse, Inngest (async job), Vitest (unit + integration, Postgres service container in CI).

---

## Context the implementer needs

**Why this exists:** OSOSS (ososs.com, ex-zfloos.com) is the Kuwait retail-ERP competitor FWB displaces. Its product export uses `parent_sku` + a dynamic size attribute (`oa_2953_size`) for variants. FWB's importer currently creates only flat products; variants must be built afterward via the Variant API — unworkable for a 462-variant catalog. pecannbee is FWB's canonical design benchmark (`design.md`, `PecannbeeProductCard.tsx`, UI rule #9) and the first real OSOSS migration.

**The converted source data** lives at `~/Downloads/pecannbee-migration/`:

- `pecannbee-converted.json` — `{ base: [203], variants: [462] }`, the migration backbone.
- `pecannbee-full-FWB-variant-import.xlsx` — 665-row combined sheet (regenerated to final column names in Task 9).
- `images/` — 337 product images downloaded off zfloos S3 as insurance.

**Key facts from the live code (verified, with refs):**

- `ProductVariant` (schema.prisma:878-911) carries its OWN `sku`, `barcode`, `price` (Int, **fils**, nullable→inherit product price), `compareAtPrice`, `costPrice`, `inventory` (Int default 0), `weight` (Float?), `imageUrl`, `position`, `isActive`, `allowBackorder`. `title` is "Large / Red" style, generated from option values.
- `ProductOption` (846-859): unique `[productId, name]`; `name`, `nameAr`, `position`.
- `ProductOptionValue` (862-875): unique `[optionId, value]`; `value`, `valueAr`, `position`.
- `ProductVariantOption` (914-923): junction `@@id([variantId, valueId])`.
- `Product.hasVariants` (692): `variant.service` auto-flips it, but we bypass that service — **we set it in our tx**.
- A variant references **1–3 option values** (`createVariantSchema` allows max 3).
- `importProducts` (bulk.service.ts:221-651): Phase1 preload (250-284) → Phase2 parse/validate (286-384) → Phase3 batch-create categories/tags (386-438) → Phase4 batch product create/update in `withMoneyTx`, BATCH_SIZE=50 (440-614) → Phase5 orphan cleanup (616-648).
- `ProductImportRow` interface: bulk.service.ts:4-29. `CSV_COLUMNS`/template: 155-180.
- xlsx→csv converter: `apps/api/src/services/xlsx-import.ts`. **Line 250** `if (!raw.name && !raw.nameAr) return null;` drops nameless rows — must allow `parentSku`. `CSV_COLUMNS` there: 316-341. `HEADER_ALIASES`: 135-209.
- Routes + Zod: bulk.routes.ts (`xlsxImportOptionsSchema` 35-45; csv import 229-284; xlsx import 293-370).
- Async runner: `apps/api/src/lib/inngest/functions/bulk-import.ts`.
- Price is **Int fils** (KWD×1000). xlsx converter already does `×1000` on `price`/`compareAtPrice`/`costPrice` (xlsx-import.ts:254-272). SKU unique per store `@@unique([storeId, sku])`; variant sku may be null.
- **No bulk-import or variant tests exist yet** — this plan adds the first. Integration tests MUST use a prod-guarded TRUNCATE (see global P0 lesson `feedback-test-truncate-wiped-prod-db`).

**Pre-req:** work in worktree `/Users/ahmadsharaf/Desktop/projects/_worktrees/force-website-builder__feat-ososs-variant-import` (branch `feat/ososs-variant-import`). Run `npm run db:generate` before any typecheck.

---

## File Structure

| File                                                     | Responsibility                                                                                                                               | Action                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `apps/api/src/services/bulk.service.ts`                  | Add `VariantImportRow`, row classifier, variant grouping, `createVariantsForProductTx` helper; hook into Phase 2 + Phase 4; extend template. | Modify                 |
| `apps/api/src/services/xlsx-import.ts`                   | Add variant canonical keys + aliases; fix nameless-row guard; include new cols in output.                                                    | Modify                 |
| `apps/api/src/routes/bulk.routes.ts`                     | No schema change needed (variant cols travel in the file); confirm template route serves new cols.                                           | Modify (template only) |
| `apps/api/tests/unit/xlsx-variant-passthrough.test.ts`   | Unit: variant rows survive xlsx→csv; price converts; guard fix.                                                                              | Create                 |
| `apps/api/tests/unit/variant-import-helpers.test.ts`     | Unit: row classifier, option dedup, title generation.                                                                                        | Create                 |
| `apps/api/tests/integration/bulk-variant-import.test.ts` | Integration: full import builds product+options+values+variants+junction+hasVariants against real DB.                                        | Create                 |
| `docs/runbooks/ososs-migration.md`                       | Migration runbook + the import sheet column spec (docs parity).                                                                              | Create                 |

---

## Convention (the import sheet contract — document verbatim in the runbook)

Existing 24 columns are unchanged. Add (all optional):

| Column                         | Meaning                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `parentSku`                    | Empty → this row is a **base product**. Non-empty → this row is a **variant** of the base product whose `sku` equals this value. |
| `option1Name` / `option1Value` | First variant axis, e.g. `Size` / `1 Kg`. Required on variant rows.                                                              |
| `option2Name` / `option2Value` | Optional 2nd axis.                                                                                                               |
| `option3Name` / `option3Value` | Optional 3rd axis (FWB max = 3).                                                                                                 |

**Base row:** full product fields; `parentSku` empty. **Variant row:** `parentSku` set; uses `sku`/`barcode`/`price`/`compareAtPrice`/`costPrice`/`inventory`/`weight` for variant data and the first URL in `images` for `variant.imageUrl`; `name`/`description`/`categories`/etc. are ignored (inherited from parent). A base product that has ≥1 variant row gets `hasVariants=true`; its own `price` is the "from" price and its own `inventory` should be left 0 (stock lives on variants).

**Rules:**

- A variant's `parentSku` must resolve to a base product present in the same file OR already in the store.
- `updateExisting=true` + existing parent that already has variants → existing options/variants are **deleted and rebuilt** from the file (same replace-semantics as categories/images today). `updateExisting=false` + existing parent → row fails with a clear error.
- Variant `title` is auto-generated as option values joined by `" / "` (e.g. `1 Kg`); `titleAr` from `valueAr` when present.

---

### Task 1: Variant types + row classifier (unit-tested pure functions)

**Files:**

- Modify: `apps/api/src/services/bulk.service.ts` (add near `ProductImportRow`, lines 4-29)
- Test: `apps/api/tests/unit/variant-import-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/tests/unit/variant-import-helpers.test.ts
import { describe, it, expect } from 'vitest';
import {
  classifyRow,
  collectOptions,
  buildVariantTitle,
  type VariantImportRow,
} from '../../src/services/bulk.service';

describe('classifyRow', () => {
  it('treats an empty parentSku as a base row', () => {
    expect(classifyRow({ name: 'Dates', sku: 'D1', parentSku: '' })).toBe('base');
  });
  it('treats a non-empty parentSku as a variant row', () => {
    expect(
      classifyRow({ parentSku: 'D1', sku: 'D1-1kg', option1Name: 'Size', option1Value: '1 Kg' })
    ).toBe('variant');
  });
});

describe('collectOptions', () => {
  it('dedupes option values across variant rows, preserving first-seen order', () => {
    const variants: VariantImportRow[] = [
      { parentSku: 'P', sku: 'P-1kg', option1Name: 'Size', option1Value: '1 Kg' },
      { parentSku: 'P', sku: 'P-500g', option1Name: 'Size', option1Value: '500 Gram' },
      { parentSku: 'P', sku: 'P-1kg-2', option1Name: 'Size', option1Value: '1 Kg' },
    ];
    const opts = collectOptions(variants);
    expect(opts).toEqual([{ name: 'Size', nameAr: undefined, values: ['1 Kg', '500 Gram'] }]);
  });
  it('supports up to three option axes', () => {
    const v: VariantImportRow[] = [
      {
        parentSku: 'P',
        sku: 'x',
        option1Name: 'Size',
        option1Value: 'S',
        option2Name: 'Color',
        option2Value: 'Red',
      },
    ];
    const opts = collectOptions(v);
    expect(opts.map(o => o.name)).toEqual(['Size', 'Color']);
  });
});

describe('buildVariantTitle', () => {
  it('joins option values with " / "', () => {
    expect(buildVariantTitle(['1 Kg'])).toBe('1 Kg');
    expect(buildVariantTitle(['S', 'Red'])).toBe('S / Red');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run tests/unit/variant-import-helpers.test.ts`
Expected: FAIL — `classifyRow`/`collectOptions`/`buildVariantTitle` not exported.

- [ ] **Step 3: Add the types + helpers to `bulk.service.ts`**

```typescript
// add after the ProductImportRow interface (around line 29)
export interface VariantImportRow {
  parentSku: string;
  sku?: string;
  barcode?: string;
  price?: number; // fils; undefined => inherit product price
  compareAtPrice?: number; // fils
  costPrice?: number; // fils
  inventory?: number;
  weight?: number;
  imageUrl?: string; // first image URL on the row
  option1Name?: string;
  option1Value?: string;
  option1ValueAr?: string;
  option2Name?: string;
  option2Value?: string;
  option2ValueAr?: string;
  option3Name?: string;
  option3Value?: string;
  option3ValueAr?: string;
}

export interface CollectedOption {
  name: string;
  nameAr?: string;
  values: string[]; // first-seen order
}

export function classifyRow(row: { parentSku?: string }): 'base' | 'variant' {
  return row.parentSku && String(row.parentSku).trim() ? 'variant' : 'base';
}

export function collectOptions(variants: VariantImportRow[]): CollectedOption[] {
  const order: string[] = [];
  const byName = new Map<string, CollectedOption>();
  for (const v of variants) {
    for (const i of [1, 2, 3] as const) {
      const name = (v as any)[`option${i}Name`]?.toString().trim();
      const value = (v as any)[`option${i}Value`]?.toString().trim();
      if (!name || !value) continue;
      if (!byName.has(name)) {
        byName.set(name, { name, nameAr: undefined, values: [] });
        order.push(name);
      }
      const opt = byName.get(name)!;
      if (!opt.values.includes(value)) opt.values.push(value);
    }
  }
  return order.map(n => byName.get(n)!);
}

export function buildVariantTitle(values: string[]): string {
  return values.join(' / ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run tests/unit/variant-import-helpers.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/bulk.service.ts apps/api/tests/unit/variant-import-helpers.test.ts
git commit -m "feat(import): add variant row types + classifier/option/title helpers"
```

---

### Task 2: Fix xlsx converter to pass variant rows + columns through

**Files:**

- Modify: `apps/api/src/services/xlsx-import.ts` (CanonicalKey union 104-133; HEADER_ALIASES 135-209; nameless guard 250; CSV_COLUMNS 316-341)
- Test: `apps/api/tests/unit/xlsx-variant-passthrough.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/tests/unit/xlsx-variant-passthrough.test.ts
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { xlsxBufferToImportCsv } from '../../src/services/xlsx-import';

async function sheetToBuffer(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('products');
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('xlsx variant passthrough', () => {
  const header = ['name', 'sku', 'price', 'parentSku', 'option1Name', 'option1Value'];

  it('keeps a variant row that has no name (parentSku present)', async () => {
    const buf = await sheetToBuffer([
      header,
      ['Dates', 'D1', '3.5', '', '', ''],
      ['', 'D1-1kg', '4.5', 'D1', 'Size', '1 Kg'],
    ]);
    const csv = await xlsxBufferToImportCsv(buf);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 data rows (variant NOT dropped)
    expect(csv).toContain('D1-1kg');
    expect(csv).toContain('1 Kg');
  });

  it('converts variant price KWD -> fils', async () => {
    const buf = await sheetToBuffer([header, ['', 'D1-1kg', '4.5', 'D1', 'Size', '1 Kg']]);
    const csv = await xlsxBufferToImportCsv(buf);
    expect(csv).toContain('4500'); // 4.5 KWD -> 4500 fils
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run tests/unit/xlsx-variant-passthrough.test.ts`
Expected: FAIL — variant row dropped (length 2) / columns unmapped.

- [ ] **Step 3: Edit `xlsx-import.ts`**

Add to the `CanonicalKey` union (after line 128, before the pseudo-keys):

```typescript
  | 'parentSku'
  | 'option1Name' | 'option1Value'
  | 'option2Name' | 'option2Value'
  | 'option3Name' | 'option3Value'
```

Add to `HEADER_ALIASES` (inside the object, English + Arabic + OSOSS synonyms):

```typescript
  parentsku: 'parentSku',
  'parent sku': 'parentSku',
  parent_sku: 'parentSku',
  'الصنف الأب': 'parentSku',
  option1name: 'option1Name',
  'option1 name': 'option1Name',
  option1value: 'option1Value',
  'option1 value': 'option1Value',
  option2name: 'option2Name',
  option2value: 'option2Value',
  option3name: 'option3Name',
  option3value: 'option3Value',
```

Change the nameless-row guard (line 250) from:

```typescript
if (!raw.name && !raw.nameAr) return null;
```

to:

```typescript
// Variant rows (identified by parentSku) inherit name from their parent.
if (!raw.name && !raw.nameAr && !raw.parentSku) return null;
```

Append the new keys to `CSV_COLUMNS` (after `'metaDescriptionAr'`, line 340):

```typescript
  'parentSku',
  'option1Name', 'option1Value',
  'option2Name', 'option2Value',
  'option3Name', 'option3Value',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run tests/unit/xlsx-variant-passthrough.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/xlsx-import.ts apps/api/tests/unit/xlsx-variant-passthrough.test.ts
git commit -m "feat(import): pass variant rows/columns through xlsx->csv converter"
```

---

### Task 3: `createVariantsForProductTx` — build options + variants inside the tx

**Files:**

- Modify: `apps/api/src/services/bulk.service.ts` (new helper; called from Phase 4)
- Test: covered by the integration test in Task 5 (this helper touches the DB, so it's exercised there, not in a unit test).

- [ ] **Step 1: Write the helper**

```typescript
// bulk.service.ts — new private helper. tx is the Prisma.TransactionClient from withMoneyTx.
async function createVariantsForProductTx(
  tx: Prisma.TransactionClient,
  productId: string,
  variants: VariantImportRow[]
): Promise<number> {
  if (variants.length === 0) return 0;

  // Replace semantics: clear any existing options/variants for this product first.
  // ProductOption & ProductVariant both cascade their children on delete.
  await tx.productVariant.deleteMany({ where: { productId } });
  await tx.productOption.deleteMany({ where: { productId } });

  // 1) Create options + values; build a (optionName|value) -> valueId map.
  const collected = collectOptions(variants);
  const valueIdByKey = new Map<string, string>();
  for (let oi = 0; oi < collected.length; oi++) {
    const opt = collected[oi];
    const option = await tx.productOption.create({
      data: { productId, name: opt.name, position: oi },
    });
    for (let vi = 0; vi < opt.values.length; vi++) {
      const value = await tx.productOptionValue.create({
        data: { optionId: option.id, value: opt.values[vi], position: vi },
      });
      valueIdByKey.set(`${opt.name}|${opt.values[vi]}`, value.id);
    }
  }

  // 2) Create each variant + its junction rows.
  let count = 0;
  for (let vi = 0; vi < variants.length; vi++) {
    const v = variants[vi];
    const pairs: Array<{ name: string; value: string }> = [];
    for (const i of [1, 2, 3] as const) {
      const name = (v as any)[`option${i}Name`]?.toString().trim();
      const value = (v as any)[`option${i}Value`]?.toString().trim();
      if (name && value) pairs.push({ name, value });
    }
    if (pairs.length === 0) continue; // skip malformed variant row (no option)

    const variant = await tx.productVariant.create({
      data: {
        productId,
        title: buildVariantTitle(pairs.map(p => p.value)),
        sku: v.sku || null,
        barcode: v.barcode || null,
        price: v.price ?? null,
        compareAtPrice: v.compareAtPrice ?? null,
        costPrice: v.costPrice ?? null,
        inventory: v.inventory ?? 0,
        weight: v.weight ?? null,
        imageUrl: v.imageUrl || null,
        position: vi,
      },
    });

    for (const p of pairs) {
      const valueId = valueIdByKey.get(`${p.name}|${p.value}`);
      if (!valueId) continue;
      await tx.productVariantOption.create({
        data: { variantId: variant.id, valueId },
      });
    }
    count++;
  }

  // 3) Flag the product (we bypass variant.service, so we own this).
  await tx.product.update({ where: { id: productId }, data: { hasVariants: true } });
  return count;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/ahmadsharaf/Desktop/projects/_worktrees/force-website-builder__feat-ososs-variant-import && npm run db:generate && cd apps/api && npx tsc --noEmit`
Expected: no errors in `bulk.service.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/bulk.service.ts
git commit -m "feat(import): add createVariantsForProductTx (options+variants in batch tx)"
```

---

### Task 4: Wire variant parsing (Phase 2) + creation (Phase 4) into `importProducts`

**Files:**

- Modify: `apps/api/src/services/bulk.service.ts` (Phase 2 parse 286-384; Phase 4 batch 440-614; result object)

- [ ] **Step 1: Parse + group variant rows in Phase 2**

In the row loop (around line 301), branch on `classifyRow`. Base rows keep the existing path and additionally record their `sku` so variants can attach. Variant rows are parsed into `VariantImportRow` and grouped:

```typescript
// before the row loop:
const variantsByParent = new Map<string, VariantImportRow[]>();

// inside the loop, FIRST thing per row:
if (classifyRow(row) === 'variant') {
  const parentSku = String(row.parentSku).trim();
  const v: VariantImportRow = {
    parentSku,
    sku: row.sku?.toString().trim() || undefined,
    barcode: row.barcode?.toString().trim() || undefined,
    price:
      row.price !== undefined && row.price !== '' ? parseInt(String(row.price), 10) : undefined,
    compareAtPrice: row.compareAtPrice ? parseInt(String(row.compareAtPrice), 10) : undefined,
    costPrice: row.costPrice ? parseInt(String(row.costPrice), 10) : undefined,
    inventory:
      row.inventory !== undefined && row.inventory !== ''
        ? parseInt(String(row.inventory), 10)
        : undefined,
    weight: row.weight ? parseFloat(String(row.weight)) : undefined,
    imageUrl: row.images ? String(row.images).split(',')[0].trim() : undefined,
    option1Name: row.option1Name,
    option1Value: row.option1Value,
    option2Name: row.option2Name,
    option2Value: row.option2Value,
    option3Name: row.option3Name,
    option3Value: row.option3Value,
  };
  if (!v.option1Name || !v.option1Value) {
    result.errors.push({ row: rowNumber, error: 'Variant row needs option1Name + option1Value' });
    result.failed++;
    continue;
  }
  variantsByParent.set(parentSku, [...(variantsByParent.get(parentSku) ?? []), v]);
  continue; // variant rows are not base products
}
// ...existing base-product validation/collection continues unchanged...
```

Note: the parsed `ProductImportRow` already carries `price` in fils for CSV input; for XLSX the converter pre-multiplied. Variant `price`/`inventory` here come from the SAME converted columns, so they're already fils/ints — `parseInt` is safe.

- [ ] **Step 2: Attach variants after product upsert in Phase 4**

Inside the batch transaction (after the product is created/updated and its categories/tags/images are written, around line 578, BEFORE the per-row catch), add:

```typescript
const productSku = productData.sku; // the sku used for this base product
if (productSku && variantsByParent.has(productSku)) {
  const made = await createVariantsForProductTx(tx, product.id, variantsByParent.get(productSku)!);
  result.variantsCreated = (result.variantsCreated ?? 0) + made;
  variantsByParent.delete(productSku); // mark consumed
}
```

- [ ] **Step 3: Attach variants whose parent already existed in the store (not in this file)**

After the batch loop (after line 614, before Phase 5), resolve any leftover variant groups against existing products:

```typescript
for (const [parentSku, variants] of variantsByParent.entries()) {
  const existing = existingBySku.get(parentSku); // Map built in Phase 1 (line ~250)
  if (!existing) {
    result.errors.push({ row: 0, error: `Variant parent sku not found: ${parentSku}` });
    result.failed += variants.length;
    continue;
  }
  try {
    await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
      const made = await createVariantsForProductTx(tx, existing.id, variants);
      result.variantsCreated = (result.variantsCreated ?? 0) + made;
    });
  } catch (e: any) {
    result.errors.push({ row: 0, error: `Variants for ${parentSku}: ${e.message}` });
    result.failed += variants.length;
  }
}
```

(If the Phase-1 map is named differently, use that name — confirm at line ~250. It is a `Map<sku, product>`.)

- [ ] **Step 4: Add `variantsCreated` to the result type**

Find the result object init in `importProducts` (the `{ total, created, updated, failed, errors }` object) and add `variantsCreated: 0`. Add `variantsCreated?: number` to its TypeScript type/interface.

- [ ] **Step 5: Typecheck**

Run: `cd <worktree> && npm run db:generate && cd apps/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/bulk.service.ts
git commit -m "feat(import): create variants from parentSku rows during bulk import"
```

---

### Task 5: Integration test — full variant import against a real DB

**Files:**

- Create: `apps/api/tests/integration/bulk-variant-import.test.ts`

This is the load-bearing test. It uses the repo's integration DB (Postgres service in CI; local Postgres in dev) and MUST be prod-guarded.

- [ ] **Step 1: Write the test**

```typescript
// apps/api/tests/integration/bulk-variant-import.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { BulkService } from '../../src/services/bulk.service';

// --- prod guard (per global P0 lesson feedback-test-truncate-wiped-prod-db) ---
function guardNotProd() {
  const url = process.env.DATABASE_URL ?? '';
  const host = (url.match(/@([^:/]+)/)?.[1] ?? '').toLowerCase();
  const looksLocal = host === 'localhost' || host === '127.0.0.1' || host === 'postgres';
  const looksManaged = /neon|railway|supabase|amazonaws/.test(url);
  if (!looksLocal || looksManaged) {
    throw new Error(`Refusing to run destructive test against non-local DB host="${host}"`);
  }
}

const STORE_ID = '00000000-0000-0000-0000-0000000000aa';
const USER_ID = '00000000-0000-0000-0000-0000000000bb';

beforeAll(async () => {
  guardNotProd();
  // minimal store + owner so importProducts has a valid storeId
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE product_variant_options, product_variants, product_option_values, product_options, product_images, product_categories, products, categories, stores, users RESTART IDENTITY CASCADE'
  );
  await prisma.user.create({
    data: { id: USER_ID, email: 'ososs-test@example.com', password: 'x', role: 'store_admin' },
  });
  await prisma.store.create({
    data: { id: STORE_ID, name: 'OSOSS Test', slug: 'ososs-test', ownerId: USER_ID },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('bulk import with variants', () => {
  it('creates a product with a Size option and three size variants', async () => {
    const csv = [
      'name,nameAr,sku,price,barcode,inventory,categories,images,parentSku,option1Name,option1Value',
      'Salted Sunflower,الحب الشمسي,SUN,1250,SUN,0,Nuts,https://example.com/sun.jpg,,,',
      ',,SUN-1kg,2500,SUN1,40,,,SUN,Size,1 Kg',
      ',,SUN-500g,1500,SUN2,60,,,SUN,Size,500 Gram',
      ',,SUN-250g,1000,SUN3,80,,,SUN,Size,250 Gram',
    ].join('\n');

    const svc = new BulkService();
    const result = await svc.importProducts(STORE_ID, csv, { updateExisting: true });

    expect(result.created).toBe(1); // one base product
    expect(result.variantsCreated).toBe(3);
    expect(result.failed).toBe(0);

    const product = await prisma.product.findFirst({
      where: { storeId: STORE_ID, sku: 'SUN' },
      include: { options: { include: { values: true } }, variants: { include: { options: true } } },
    });
    expect(product?.hasVariants).toBe(true);
    expect(product?.options).toHaveLength(1);
    expect(product?.options[0].name).toBe('Size');
    expect(product?.options[0].values.map(v => v.value).sort()).toEqual([
      '1 Kg',
      '250 Gram',
      '500 Gram',
    ]);
    expect(product?.variants).toHaveLength(3);
    const oneKg = product?.variants.find(v => v.sku === 'SUN-1kg');
    expect(oneKg?.price).toBe(2500);
    expect(oneKg?.inventory).toBe(40);
    expect(oneKg?.title).toBe('1 Kg');
    expect(oneKg?.options).toHaveLength(1); // junction row
  });

  it('re-import with updateExisting rebuilds variants without duplicating', async () => {
    const csv = [
      'name,sku,price,parentSku,option1Name,option1Value',
      'Salted Sunflower,SUN,1250,,,',
      ',SUN-1kg,2600,SUN,Size,1 Kg',
    ].join('\n');
    const svc = new BulkService();
    await svc.importProducts(STORE_ID, csv, { updateExisting: true });
    const variants = await prisma.productVariant.findMany({ where: { product: { sku: 'SUN' } } });
    expect(variants).toHaveLength(1); // rebuilt, not appended
    expect(variants[0].price).toBe(2600);
  });
});
```

- [ ] **Step 2: Run it (expects Postgres on DATABASE_URL)**

Run: `cd apps/api && npx vitest run tests/integration/bulk-variant-import.test.ts`
Expected: PASS. If `BulkService` is exported differently (e.g. a singleton/functions), adjust the import to match the actual export and re-run.

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/integration/bulk-variant-import.test.ts
git commit -m "test(import): integration coverage for variant bulk import + re-import"
```

---

### Task 6: Extend the import template + CSV export to round-trip variants

**Files:**

- Modify: `apps/api/src/services/bulk.service.ts` (`getImportTemplate` 155-180; `exportProducts` 50-149)

- [ ] **Step 1: Add the new columns + a sample variant row to `getImportTemplate`**

Append `parentSku,option1Name,option1Value,option2Name,option2Value,option3Name,option3Value` to the header, leave them blank in the existing example row, and add a second example row demonstrating a variant:

```
,,,,,,,,SAMPLE-1KG,,40,,true,,active,false,false,,,,,,,,SAMPLE,Size,1 Kg,,,,
```

(Match the exact column count of the template header.)

- [ ] **Step 2: Export variants as rows in `exportProducts`**

Change the product query `include` to add `variants: { include: { options: { include: { value: { include: { option: true } } } } } }`. After emitting a product's base row, emit one row per variant: blank base fields except an identifying note, set `parentSku` = product.sku, fill `sku/barcode/price(÷1000)/inventory`, and `option1Name/Value` from the variant's option values. Add the 7 new headers to the export header list.

- [ ] **Step 3: Typecheck + the export half of an existing/quick test**

Run: `cd <worktree> && npm run db:generate && cd apps/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/bulk.service.ts
git commit -m "feat(import): template + export round-trip variant rows"
```

---

### Task 7: Migration runbook + docs parity

**Files:**

- Create: `docs/runbooks/ososs-migration.md`

- [ ] **Step 1: Write the runbook**

Document: (a) what OSOSS/zfloos is and the export shape; (b) the full import-sheet column contract from the "Convention" section above; (c) the conversion recipe (the `~/Downloads/pecannbee-migration` scripts) for future OSOSS merchants; (d) the image strategy (live-URL ingestion + S3-insurance archive); (e) the post-import AI-autopilot cleanup for Arabic-in-`en_*` fields; (f) the admin steps (Bulk Import wizard → upload XLSX → poll job).

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/ososs-migration.md
git commit -m "docs: OSOSS->FWB variant migration runbook + import sheet spec"
```

---

### Task 8: Full gate pass (lint, typecheck, unit, integration, audit)

- [ ] **Step 1: Run the gates from the worktree root**

```bash
cd /Users/ahmadsharaf/Desktop/projects/_worktrees/force-website-builder__feat-ososs-variant-import
npm run db:generate
npm run lint
npm run typecheck
cd apps/api && npx vitest run tests/unit tests/integration && cd ../..
npx prettier@3.1.0 --config .prettierrc --write $(git diff --name-only origin/main..HEAD | grep -E '\.(ts|tsx|js|jsx|json|md)$')
npm audit --audit-level=low --omit=dev
```

Expected: all green; audit 0 prod vulns.

- [ ] **Step 2: Commit any formatting**

```bash
git add -A && git commit -m "chore: format + lint pass for variant import" || echo "nothing to format"
```

---

### Task 9: Onboard pecannbee (requires store ID + admin token from Ahmad)

**Files:** none in-repo — execution against the provisioned store.

- [ ] **Step 1: Regenerate the combined sheet with final column names**

Update `~/Downloads/pecannbee-migration` generator to emit `option1Name`/`option1Value` (not `optionName`/`optionValue`) and re-run to produce `pecannbee-full-FWB-variant-import.xlsx`.

- [ ] **Step 2: Import via the admin Bulk wizard (or API)** into the pecannbee store; poll the job to completion. Verify `created≈203`, `variantsCreated≈462`, `failed=0` (investigate any failures).

- [ ] **Step 3: Spot-check the storefront** — open 3 configurable products (e.g. dates, sunflower seeds) and confirm the size dropdown shows the right sizes/prices/stock, and images render from R2.

- [ ] **Step 4: Run AI autopilot** to clean Arabic-in-`en_*` fields (bidirectional EN↔AR), then re-verify a sample.

- [ ] **Step 5: If zfloos S3 is already dead** at import time, re-host `~/Downloads/pecannbee-migration/images/` to R2 and swap the `images` column to the new URLs before importing.

---

## Self-Review

- **Spec coverage:** convention (Tasks 2,4,6,7) ✓; variant model creation (Task 3) ✓; backward compat (Task 2 guard + base path untouched) ✓; xlsx + csv paths (Tasks 2,4) ✓; tests unit+integration (Tasks 1,2,5) ✓; export round-trip (Task 6) ✓; docs parity (Task 7) ✓; gates (Task 8) ✓; pecannbee onboarding (Task 9) ✓.
- **Placeholder scan:** all code steps contain real code; no TBD/TODO.
- **Type consistency:** `VariantImportRow`, `CollectedOption`, `classifyRow`, `collectOptions`, `buildVariantTitle`, `createVariantsForProductTx`, `result.variantsCreated` used consistently across Tasks 1,3,4,5.
- **Open verification at execution time (not blockers):** exact name of the Phase-1 `Map<sku, product>` (~line 250); exact `BulkService` export shape (class vs functions) for the integration test import; whether `withMoneyTx` is the right tx wrapper to reuse for the leftover-parents loop (it is — same one Phase 4 uses).

## Risks / notes

- **5-layer testing:** this plan delivers unit + integration as CI gates. The admin-upload E2E is covered functionally by the integration test hitting `importProducts`; a Playwright wizard-upload E2E is a reasonable follow-up but not required to ship the API capability. UAT = Task 9 storefront spot-check.
- **No schema migration** is required (all variant tables already exist; `variantsCreated` is an in-memory result field, not a persisted column). If we later want it on `BulkImportJob`, that's a separate nullable-column migration.
- **Active session coordination:** another session runs ~15 FWB feature worktrees. This branch is isolated; merge via PR, and rebase on origin/main before the final gate pass in case `bulk.service.ts` moved.
