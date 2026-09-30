/**
 * Issues 2345 / 2346: the read-only report of old-shape variant-less PO lines
 * on variant products, run against a real migrated Postgres. Positive control:
 * a variant-less line on a SIMPLE product, and a line that names its variant,
 * are NOT reported. Per-call ids (retry-safe).
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { withRlsBypass } from '@force/database';
import { hasDb, seedBundleStore } from '../helpers/bundle-fixtures';
import { findVariantlessLines } from '../../scripts/list-variantless-po-lines';

describe.skipIf(!hasDb)('list-variantless-po-lines', () => {
  it('reports only variant-less lines whose product has variants, per PO status', async () => {
    const uniq = crypto.randomBytes(4).toString('hex');
    const store = await seedBundleStore(`vlpo-${uniq}`);
    const slug = `bundle-fixture-vlpo-${uniq}`;
    await withRlsBypass(async tx => {
      const supplier = await tx.supplier.create({
        data: { storeId: store.storeId, name: 'S' },
      });
      const variantProduct = await tx.product.create({
        data: { storeId: store.storeId, name: 'VP', slug: `vp-${uniq}`, price: 1000, hasVariants: true },
      });
      const variant = await tx.productVariant.create({
        data: { productId: variantProduct.id, title: 'A', price: 1000, inventory: 0 },
      });
      const simple = await tx.product.create({
        data: { storeId: store.storeId, name: 'SP', slug: `sp-${uniq}`, price: 1000 },
      });
      const po = (poNumber: string, status: 'sent' | 'partial') =>
        tx.purchaseOrder.create({
          data: { storeId: store.storeId, supplierId: supplier.id, poNumber, status },
        });
      const sent = await po(`PO-S-${uniq}`, 'sent');
      const partial = await po(`PO-P-${uniq}`, 'partial');
      const line = (poId: string, productId: string, variantId: string | null, qtyReceived = 0) =>
        tx.purchaseOrderItem.create({
          data: { poId, productId, variantId, qty: 10, qtyReceived, unitCost: 100, total: 1000 },
        });
      await line(sent.id, variantProduct.id, null); // reported
      await line(partial.id, variantProduct.id, null, 4); // reported, received 4
      await line(sent.id, variantProduct.id, variant.id); // names its variant — not reported
      await line(sent.id, simple.id, null); // simple product — not reported
    });

    const res = await withRlsBypass(tx =>
      findVariantlessLines(tx as never, slug)
    );
    expect(res.po).toEqual([
      // Ordered by the status enum (sent before partial).
      { storeSlug: slug, poNumber: `PO-S-${uniq}`, poStatus: 'sent', lines: 1, openQty: 10, receivedQty: 0 },
      { storeSlug: slug, poNumber: `PO-P-${uniq}`, poStatus: 'partial', lines: 1, openQty: 6, receivedQty: 4 },
    ]);
    expect(res.backorders).toEqual([]);
  });
});
