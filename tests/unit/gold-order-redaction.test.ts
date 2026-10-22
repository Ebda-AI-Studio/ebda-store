/**
 * Ruling B5-13: a customer reads their order WITHOUT the merchant's cost and the gold margin, the making
 * charge or the rate row id. The admin read is unfiltered. Mutation-tested: `money-gold-order-redaction`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { goldLineNote, redactOrderForCustomer } from '../../apps/api/src/services/gold-rate/public';

const snap = {
  karat: 21,
  weightMg: 4350,
  ratePerGram: 410000,
  rateAppliedAt: '2026-10-22T06:00:00.000Z',
  unitPrice: 2_050_000,
  marginBps: 700,
  makingChargeType: 'per_gram',
  makingChargeValue: 15000,
  rateId: 'rate-secret-id',
  roundingStep: 100,
};

describe('redactOrderForCustomer', () => {
  const out = redactOrderForCustomer({
    id: 'o1',
    items: [
      { id: 'i1', costPrice: 1_700_000, price: 2_050_000, goldSnapshot: snap },
      { id: 'i2', costPrice: 100, price: 500, goldSnapshot: null },
    ],
  });

  it('keeps only what the shopper was shown on a gold line', () => {
    expect(Object.keys(out.items[0]!.goldSnapshot as object).sort()).toEqual(
      ['karat', 'rateAppliedAt', 'ratePerGram', 'unitPrice', 'weightMg'].sort()
    );
    expect(JSON.stringify(out)).not.toMatch(/marginBps|makingCharge|rate-secret-id|roundingStep/);
  });

  it('removes the merchant cost from every line and leaves other lines alone', () => {
    for (const i of out.items as Array<Record<string, unknown>>)
      expect('costPrice' in i).toBe(false);
    expect((out.items[1] as { goldSnapshot: unknown }).goldSnapshot).toBeNull();
    expect((out.items[1] as { price: number }).price).toBe(500);
  });

  it('passes an order with no items array through untouched', () => {
    const o = { id: 'x' };
    expect(redactOrderForCustomer(o)).toBe(o);
  });
});

describe('every customer-facing order read goes through the redaction', () => {
  it.each([
    ['apps/api/src/routes/order.routes.ts', 2],
    ['apps/api/src/services/auth.service.ts', 1],
    // the guest success page and the signed-in order list (the main customer-facing reads)
    ['apps/api/src/routes/public.routes.ts', 1],
    ['apps/api/src/services/order.service.ts', 1],
  ])('%s', (file, minUses) => {
    const src = readFileSync(file, 'utf8');
    const uses = src.split('redactOrderForCustomer').length - 1 - 1; // minus the import
    expect(uses).toBeGreaterThanOrEqual(minUses);
  });
});

describe('goldLineNote (invoice line)', () => {
  const money = (n: number) => `${(n / 100).toFixed(2)} EGP`;
  it('states karat, weight and per-gram rate in both languages, never the margin', () => {
    expect(goldLineNote(snap, 'en', money)).toBe('21 karat · 4.35 g · 4100.00 EGP per gram');
    expect(goldLineNote(snap, 'ar', money)).toBe('عيار 21 · 4.35 جم · 4100.00 EGP للجرام');
    expect(goldLineNote(snap, 'en', money)).not.toMatch(/700|margin/i);
  });
  it('is null for a line that was not gold-priced', () => {
    expect(goldLineNote(null, 'en', money)).toBeNull();
    expect(goldLineNote({ karat: 21 }, 'en', money)).toBeNull();
  });
});
