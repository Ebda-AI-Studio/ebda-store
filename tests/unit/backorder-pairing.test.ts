/**
 * #1552 — one backordered decrement must tag exactly ONE order line.
 * Bundle boxes write one order line per component per box, so N boxes of a
 * bundle holding the same product produce N lines with the same
 * (productId, variantId). A non-consuming match recorded N units of backorder
 * debt for a single short unit.
 */
import { describe, it, expect } from 'vitest';
import { pairBackorderedLines } from '@api/lib/backorder-pairing';

const line = (id: string, productId: string, quantity = 1, variantId: string | null = null) => ({
  id,
  productId,
  variantId,
  quantity,
});

describe('pairBackorderedLines', () => {
  it('3 bundle boxes sharing a product, 1 short unit → exactly ONE backorder line', () => {
    const lines = [
      line('box1-dates', 'dates'),
      line('box2-dates', 'dates'),
      line('box3-dates', 'dates'),
    ];
    const pairs = pairBackorderedLines(lines, [{ productId: 'dates', quantity: 1 }]);
    expect(pairs).toHaveLength(1);
    expect(pairs.reduce((n, p) => n + p.quantity, 0)).toBe(1);
  });

  it('pairs each entry once, preferring the line whose quantity caused it', () => {
    const lines = [line('loose', 'dates', 4), line('box1', 'dates', 1)];
    const pairs = pairBackorderedLines(lines, [{ productId: 'dates', quantity: 1 }]);
    expect(pairs.map(p => p.line.id)).toEqual(['box1']);
    expect(pairs[0].quantity).toBe(1);
  });

  it('keeps variants apart and ignores unrelated lines', () => {
    const lines = [line('a', 'shirt', 1, 'red'), line('b', 'shirt', 1, 'blue'), line('c', 'mug')];
    const pairs = pairBackorderedLines(lines, [
      { productId: 'shirt', variantId: 'blue', quantity: 1 },
    ]);
    expect(pairs.map(p => p.line.id)).toEqual(['b']);
  });

  it('two short lines on the same SKU → two backorder lines (control)', () => {
    const lines = [line('box1', 'dates'), line('box2', 'dates'), line('box3', 'dates')];
    const pairs = pairBackorderedLines(lines, [
      { productId: 'dates', quantity: 1 },
      { productId: 'dates', quantity: 1 },
    ]);
    expect(pairs).toHaveLength(2);
    // …on two DIFFERENT lines — one decrement, one line.
    expect(new Set(pairs.map(p => p.line.id)).size).toBe(2);
  });
});
