/**
 * Shipping-fee hint (plan 4.2 #3, Rulings CI-10 and CI-13): where COD orders start to return more as the
 * SHIPPING FEE the buyer was charged grows, suggest a threshold. Shown as a suggestion card on the
 * dashboard. Since CI-13 the stream carries the real fee (`shippingFeeMinor`), so this reads
 * `return_by_shipping_fee`; the COD-amount proxy of CI-10 is gone from the hint (the amount metric
 * stays in the aggregates for the insights page). Events from before the fee existed are not counted.
 */
import { ANY, feeBucketLowerMinor } from '../aggregate/cells';
import { wilsonLower } from '../aggregate/stats';
import { pickCell, type HintData, type Scope } from './thresholds';

export interface FeeHint {
  status: 'ok' | 'insufficient';
  suggestion: {
    /** Shipping fee (piastres) at and above which COD orders return more. */
    thresholdMinor: number;
    rate: number;
    baselineRate: number;
    n: number;
    scope: Scope;
  } | null;
}

export function feeHint(data: HintData): FeeHint {
  let anyBaseline = false;
  for (const scope of ['store', 'cohort'] as const) {
    const base = pickCell(data, scope, 'return_by_shipping_fee', [ANY]);
    if (!base) continue;
    anyBaseline = true;
    const baseRate = base.hit / base.n;
    for (const bucket of ['f1', 'f2', 'f3', 'f4']) {
      const c = pickCell(data, scope, 'return_by_shipping_fee', [bucket]);
      if (c && wilsonLower(c.hit, c.n) > baseRate) {
        return {
          status: 'ok',
          suggestion: {
            thresholdMinor: feeBucketLowerMinor(bucket),
            rate: c.hit / c.n,
            baselineRate: baseRate,
            n: c.n,
            scope,
          },
        };
      }
    }
  }
  return { status: anyBaseline ? 'ok' : 'insufficient', suggestion: null };
}
