/**
 * F8 is a defect CLASS: a variant title printed as one bidi run reorders mixed Arabic/Latin
 * values ("وردي / M / 54 سم" read as "وردي / 54 / M سم"; a seamstress could swap size and
 * length). Every surface that prints one must isolate each option value (`VariantText` /
 * `variantTitleSegments`) and never print the raw title as a single text node.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const R = join(__dirname, '../..');
const SURFACES = [
  'apps/web/src/app/cart/CartClient.tsx',
  'apps/web/src/templates/minimal/CartTable.tsx',
  'apps/web/src/templates/modern/CartTable.tsx',
  'apps/web/src/templates/classic/CartTable.tsx',
  'apps/web/src/templates/elegant/CartTable.tsx',
  'apps/web/src/templates/bold/CartTable.tsx',
  'apps/web/src/templates/dahab/CartTable.tsx',
  'apps/web/src/templates/dahab/CartDrawer.tsx',
  'apps/web/src/components/commerce/ReceiptPrinter.tsx',
  'apps/web/src/app/account/orders/[id]/OrderDetailClient.tsx',
  'apps/admin/src/app/stores/[id]/orders/[orderId]/_components/ItemsCard.tsx',
  'apps/admin/src/app/stores/[id]/stock/scan/page.tsx',
  'apps/admin/src/app/stores/[id]/stock/warehouses/[warehouseId]/page.tsx',
  'apps/admin/src/app/stores/[id]/stock/reorder/page.tsx',
  'apps/orders/src/app/orders/[orderId]/_components/ItemsCard.tsx',
  'apps/api/src/services/email-templates/order-confirmation.ts',
];

describe('every variant-title surface isolates each option value', () => {
  it.each(SURFACES)('%s', f => {
    const src = readFileSync(join(R, f), 'utf8');
    expect(src).toMatch(/VariantText|variantTitleSegments/);
    // no raw title as one text node
    expect(src).not.toMatch(
      /(?<!=)\{(item|row\.item|row|line|lookup|lookupResult)\.variant(Name|Title)(Ar)?\}/
    );
    expect(src).not.toMatch(/\$\{[\w.]*variant(Name|Title)\}/);
    expect(src).not.toMatch(/^\s*\{(variant|variantName)\}\s*$/m);
  });

  it('order surfaces pick the title per language through orderLineVariantTitle (B0-41)', () => {
    for (const f of SURFACES.filter(
      f => !/CartTable|CartDrawer|CartClient|warehouses|reorder/.test(f)
    )) {
      expect(readFileSync(join(R, f), 'utf8'), f).toContain('orderLineVariantTitle');
    }
  });
});
