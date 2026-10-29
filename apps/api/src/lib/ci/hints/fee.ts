/**
 * Price / COD-amount hint (plan 4.2 #3, Ruling CI-10): where COD orders start to return more as the
 * amount grows, suggest a deposit threshold. Shown as a suggestion card on the dashboard. The stream
 * carries the COD amount, not the shipping fee, so the amount band is the proxy (Ruling CI-10).
 */
import { ANY, bucketLowerMinor } from '../aggregate/cells';
import { wilsonLower } from '../aggregate/stats';
import { pickCell, type HintData, type Scope } from './thresholds';

export interface FeeHint {
  status: 'ok' | 'insufficient';
  suggestion: {
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
    const base = pickCell(data, scope, 'cod_return_by_amount', [ANY]);
    if (!base) continue;
    anyBaseline = true;
    const baseRate = base.hit / base.n;
    for (const bucket of ['b1', 'b2', 'b3', 'b4']) {
      const c = pickCell(data, scope, 'cod_return_by_amount', [bucket]);
      if (c && wilsonLower(c.hit, c.n) > baseRate) {
        return {
          status: 'ok',
          suggestion: {
            thresholdMinor: bucketLowerMinor(bucket),
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
