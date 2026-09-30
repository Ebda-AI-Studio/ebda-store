/**
 * Server-side half of scripts/check-update-payload-clear.mjs.
 *
 * That gate forces an admin EDIT form to send `null` for an emptied field
 * (via `textFieldValue` / `numericFieldValue` / `dateFieldValue` from
 * apps/admin/src/lib/form-text.ts) instead of a dropped `undefined`. It reads
 * only the CALLER, so it cannot see whether the receiving Zod update schema
 * accepts `null`. PR 1978 converted the supplier form, the route's schema was
 * `createSchema.partial()` over plain `.optional()` strings, and every
 * supplier edit 422'd — the client gate was green the whole time.
 *
 * This test closes the pair:
 *   1. every admin/orders/web file that calls a clear-on-empty helper must be
 *      registered below against the update schema its payload hits — an
 *      unregistered file fails, so a new conversion cannot skip this check;
 *   2. every field the file builds with a helper must be registered;
 *   3. the registered schema must accept `null` for every registered field.
 *
 * Forms that send a literal `null` without the helper (promotions, bundles)
 * are registered by hand in `extraFields` — the discovery step cannot see
 * them, so they are the part a reviewer has to keep in step.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { ZodTypeAny } from 'zod';
// Source, not the package entry: `@force/shared` resolves to the last DIST build.
import { locationInputSchema } from '@shared/src/schemas/location';
import { SCAN_ROOTS } from '../../scripts/check-update-payload-clear.mjs';

const ROOT = path.resolve(__dirname, '../..');
const HELPER_CALL = /\b(\w+)\s*:\s*(?:text|numeric|date)FieldValue\(/g;
const HELPER_ANY = /\b(?:text|numeric|date)FieldValue\(/;

interface Surface {
  /** Update schema the file's PUT/PATCH body is validated by. */
  schema: () => Promise<ZodTypeAny>;
  /** Wrap a `{ field: null }` patch into the body shape the schema expects. */
  wrap?: (patch: Record<string, null>) => unknown;
  /** Fields the client can null WITHOUT going through a helper. */
  extraFields?: string[];
}

const SURFACES: Record<string, Surface> = {
  'apps/admin/src/app/stores/[id]/stock/suppliers/new/page.tsx': {
    schema: async () => (await import('@api/routes/suppliers.routes')).updateSchema,
  },
  'apps/admin/src/app/stores/[id]/tax/page.tsx': {
    schema: async () => (await import('@api/routes/tax.routes')).updateTaxRateSchema,
  },
  'apps/admin/src/app/stores/[id]/categories/page.tsx': {
    schema: async () => (await import('@api/routes/category.routes')).updateCategorySchema,
  },
  'apps/admin/src/app/stores/[id]/coupons/_hooks/useCoupons.ts': {
    schema: async () => (await import('@api/routes/coupon.routes')).updateCouponSchema,
  },
  'apps/admin/src/app/stores/[id]/stock/warehouses/page.tsx': {
    schema: async () => (await import('@api/routes/warehouse.routes')).updateWarehouseSchema,
  },
  'apps/admin/src/app/stores/[id]/branding/_components/LocationsTab.tsx': {
    // locations.routes.ts PUT: `locationInputSchema.partial().parse(req.body)`
    schema: async () => locationInputSchema.partial(),
  },
  'apps/admin/src/lib/product-payload.ts': {
    schema: async () => (await import('@api/routes/product.routes')).updateProductSchema,
  },
  'apps/admin/src/lib/checkout-delivery-payload.ts': {
    // Sent as the store's whole `settings` blob on PUT /stores/:id.
    schema: async () => (await import('@api/routes/store.routes')).updateStoreSchema,
    wrap: patch => ({ settings: patch }),
  },
  'apps/admin/src/app/stores/[id]/promotions/page.tsx': {
    schema: async () => (await import('@api/routes/promotion.routes')).updateSchema,
    extraFields: [
      'nameAr',
      'description',
      'descriptionAr',
      'maxDiscount',
      'startsAt',
      'expiresAt',
      'customerGroupId',
      'minOrderAmount',
      'minQuantity',
    ],
  },
  'apps/admin/src/app/stores/[id]/bundles/page.tsx': {
    schema: async () => (await import('@api/routes/bundle.routes')).updateSchema,
    extraFields: ['nameAr', 'description', 'descriptionAr', 'image', 'startsAt', 'expiresAt'],
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '__tests__') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function helperFields(rel: string): string[] {
  const src = readFileSync(path.join(ROOT, rel), 'utf8');
  return [...src.matchAll(HELPER_CALL)].map(m => m[1]);
}

const discovered = (SCAN_ROOTS as string[])
  .flatMap(r => walk(path.join(ROOT, r)))
  .map(f => path.relative(ROOT, f))
  .filter(rel => !rel.endsWith('lib/form-text.ts'))
  .filter(rel => HELPER_ANY.test(readFileSync(path.join(ROOT, rel), 'utf8')));

describe('clear-on-empty: the server accepts every null the client sends', () => {
  it('discovers the helper callers (positive control — an empty scan would pass everything)', () => {
    expect(discovered.length).toBeGreaterThanOrEqual(7);
  });

  it('every file that calls a clear-on-empty helper is registered here', () => {
    const unregistered = discovered.filter(rel => !(rel in SURFACES));
    expect(unregistered, 'register these against their server update schema').toEqual([]);
  });

  it('every registered file still exists (a moved file must be re-registered)', () => {
    const missing = Object.keys(SURFACES).filter(rel => {
      try {
        statSync(path.join(ROOT, rel));
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });

  for (const [rel, surface] of Object.entries(SURFACES)) {
    it(`${rel}: the update schema accepts null for every clearable field`, async () => {
      const fields = [...new Set([...helperFields(rel), ...(surface.extraFields ?? [])])];
      expect(fields.length, 'no clearable fields found — the extractor is broken').toBeGreaterThan(
        0
      );
      const schema = await surface.schema();
      const rejected: string[] = [];
      for (const field of fields) {
        const body = surface.wrap ? surface.wrap({ [field]: null }) : { [field]: null };
        const result = schema.safeParse(body);
        if (result.success) continue;
        // A partial schema may still reject the body for an unrelated
        // cross-field refine; only an issue ON this field is the defect.
        const onField = result.error.issues.some(i =>
          surface.wrap ? i.path[0] === 'settings' : i.path[0] === field
        );
        if (onField) rejected.push(field);
      }
      expect(rejected, `${rel}: server rejects null for these — the edit 422s`).toEqual([]);
    });
  }
});
