/**
 * Ruling CF-RETURNS-1: the StoreDO engine imports no workspace package, so the return math is VERBATIM copies of the
 * originals. This keeps them equal (byte for byte after the two-line header) and fuzzes the three functions so the
 * copy and the original cannot answer differently.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  allocatePartialReturn as aOrig,
  splitByPaymentMix as sOrig,
} from '../../apps/api/src/services/accounting/posting/partial-return-allocation';
import {
  allocatePartialReturn as aCopy,
  splitByPaymentMix as sCopy,
} from '../../packages/repo/src/do/return-allocation';
import { productReturnAdjustment as pOrig } from '../../packages/shared/src/pricing/return-adjustment';
import { productReturnAdjustment as pCopy } from '../../packages/repo/src/do/return-adjustment';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const body = (s: string) => s.split('\n').slice(2).join('\n');

describe('the engine copies equal the originals', () => {
  it('allocation: same text', () => {
    expect(body(read('packages/repo/src/do/return-allocation.ts'))).toBe(
      read('apps/api/src/services/accounting/posting/partial-return-allocation.ts')
    );
  });
  it('tier adjustment: same text', () => {
    expect(body(read('packages/repo/src/do/return-adjustment.ts'))).toBe(
      read('packages/shared/src/pricing/return-adjustment.ts')
    );
  });
  it('allocation + split: fuzzed answers are equal', () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let i = 0; i < 400; i++) {
      const lines = Array.from({ length: 1 + rnd(4) }, (_, k) => ({
        id: `l${k}`,
        quantity: 1 + rnd(5),
        price: 100 * (1 + rnd(90)),
        priceSource: rnd(4) === 0 ? 'tier' : null,
      }));
      const subtotal = lines.reduce((s, l) => s + l.price * l.quantity, 0);
      const input = {
        subtotal,
        discount: rnd(3) === 0 ? 0 : rnd(Math.max(1, subtotal / 3)),
        tax: rnd(Math.max(1, subtotal / 5)),
        taxIncludedInPrice: rnd(2) === 0,
        lines,
        prevQty: new Map(lines.filter(() => rnd(3) === 0).map(l => [l.id, rnd(l.quantity + 1)])),
        requested: lines.map(l => ({ orderItemId: l.id, quantity: rnd(l.quantity + 2) })),
        prevAdjustment: rnd(3) === 0 ? rnd(200) : 0,
        thisAdjustment: rnd(3) === 0 ? rnd(200) : 0,
      };
      expect(aCopy(input)).toEqual(aOrig(input));
      const split = {
        cashCredit: rnd(5000),
        prevCash: rnd(5000),
        total: rnd(20000),
        walletAmount: rnd(10000),
      };
      expect(sCopy(split)).toEqual(sOrig(split));
    }
  });
  it('productReturnAdjustment: fuzzed answers are equal', () => {
    let seed = 11;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let i = 0; i < 300; i++) {
      const lines = Array.from({ length: 1 + rnd(3) }, (_, k) => {
        const quantity = 1 + rnd(8);
        return {
          key: `k${k}`,
          variantId: rnd(2) ? null : 'v',
          quantity,
          paidUnitMinor: 1000 - rnd(300),
          listMinor: 1000,
          priceSource: (['tier', 'base', null] as const)[rnd(3)],
          tierMinQty: rnd(2) ? 1 + rnd(5) : null,
          ladder: {
            rungs: [
              { minQty: 2, priceMinor: 900, variant: false, group: false },
              { minQty: 5, priceMinor: 800, variant: false, group: false },
            ],
            groupPercentMinor: null,
          },
          returnedBefore: rnd(quantity),
          returning: rnd(quantity + 1),
        };
      });
      const items = lines.map(l => ({ key: `i-${l.key}`, lineKey: l.key, returning: l.returning }));
      const retained = rnd(300);
      const carried = rnd(100);
      expect(pCopy(lines as never, items, retained, carried)).toEqual(
        pOrig(lines as never, items, retained, carried)
      );
    }
  });
});
