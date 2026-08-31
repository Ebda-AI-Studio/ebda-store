/**
 * Invariant: one order line writes the variant row XOR the product row.
 *
 * Checkout used to decrement BOTH for a variant sale, which drove the parent
 * column of every variant product monotonically negative (24 live products,
 * to -16 at worst, while their variants held four-figure stock). The refund
 * path incremented both, and the payment rollback incremented ONLY the
 * product — so the two directions never even cancelled out.
 *
 * These are structural assertions on the source rather than behavioural ones:
 * the order transaction is a 400-line interactive Prisma tx whose faithful
 * mock would assert the mock, not the code. What matters here is that no
 * single line can reach both writers, and that is a property of the shape.
 */
import { describe, it, expect } from 'vitest';
import * as decrement from '@api/services/inventory-decrement';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('inventory-decrement module surface', () => {
  it('no longer exports an unfloored product force-decrement', () => {
    expect('forceDecrementProductInventory' in decrement).toBe(false);
  });

  it('still exports the three helpers the order path needs', () => {
    expect(typeof decrement.decrementProductInventory).toBe('function');
    expect(typeof decrement.decrementVariantInventory).toBe('function');
    expect(typeof decrement.forceDecrementVariantInventory).toBe('function');
  });
});

describe('order paths never write both rows for one line', () => {
  it('order.service.ts has no product force-decrement left', () => {
    expect(read('apps/api/src/services/order.service.ts')).not.toContain(
      'forceDecrementProductInventory'
    );
  });

  it('the refund restore guards the product increment behind "no variantId"', () => {
    const src = read('apps/api/src/lib/inngest/functions/order-refunded.ts');
    // The variant branch must come first and the product increment must sit
    // in its else-branch — not unconditionally above it, as it used to.
    expect(src).toMatch(
      /if \(item\.variantId\) \{[\s\S]{0,600}?productVariant\.update[\s\S]{0,400}?\} else \{[\s\S]{0,400}?product\.update/
    );
  });

  it('the payment rollback restores the variant when the line has one', () => {
    const src = read('apps/api/src/services/order.service.ts');
    // Slice the rollback's restore loop — from its comment to the
    // InventoryHistory row that closes it — and assert both branches exist.
    const start = src.indexOf('// 1. Restore inventory');
    expect(start, 'rollback restore loop not found').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('Order rollback — payment step failed', start));

    expect(block).toContain('if (item.variantId)');
    expect(block).toContain('tx.productVariant.update');
    expect(block).toContain('tx.product.update');
    // The product increment must be the else-branch, not unconditional: it
    // has to appear AFTER the variant one inside the same if/else.
    expect(block.indexOf('tx.productVariant.update')).toBeLessThan(
      block.indexOf('tx.product.update')
    );
  });
});
