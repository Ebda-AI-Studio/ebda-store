/**
 * COD risk hint (plan 4.2 #1, Ruling CI-10): a band for one order from its area's return rate and, inside
 * the same store only, the buyer's own history there. ADVISE, NEVER BLOCK: this returns data for a note on
 * the order page; no order, checkout or booking code reads it.
 */
import { ANY, areaLevels, cellKey } from '../aggregate/cells';
import { wilsonLower } from '../aggregate/stats';
import { baselineCell, pickCell, type HintData, type Scope } from './thresholds';

export type Band = 'typical' | 'elevated' | 'insufficient';
export type Suggestion = 'confirm_by_phone' | 'ask_instapay_deposit';

/** The buyer's record in THIS store (their own earlier shipments): never read from another store. */
export interface BuyerHistory {
  shipped: number;
  returned: number;
}
/** Two returns, and at least half of what was shipped to them. */
export const BUYER_MIN_RETURNS = 2;
export const BUYER_MIN_RETURN_SHARE = 0.5;

export interface CodRiskHint {
  band: Band;
  source: Scope | 'none';
  /** Sample size behind the band (the area cell's n, or the buyer's shipped count when only history decided). */
  n: number;
  rate: number | null;
  baselineRate: number | null;
  areaKey: string | null;
  reasons: Array<'area' | 'buyer'>;
  suggestions: Suggestion[];
}

export function codRiskHint(
  data: HintData,
  areaKey: string | null,
  buyer: BuyerHistory | null
): CodRiskHint {
  const keys = areaLevels(areaKey).map(a => cellKey(ANY, a));
  const base = baselineCell(data, 'return_rate', cellKey(ANY, ANY));
  const baseRate = base ? base.hit / base.n : null;

  let chosen: { scope: Scope; n: number; rate: number; elevated: boolean } | undefined;
  for (const scope of ['store', 'cohort'] as const) {
    const c = pickCell(data, scope, 'return_rate', keys);
    if (!c) continue;
    const rate = c.hit / c.n;
    const elevated = baseRate != null && wilsonLower(c.hit, c.n) > baseRate;
    // Prefer an elevated reading from either scope; otherwise the first showable one.
    if (!chosen || (elevated && !chosen.elevated)) chosen = { scope, n: c.n, rate, elevated };
  }

  const buyerElevated =
    !!buyer &&
    buyer.returned >= BUYER_MIN_RETURNS &&
    buyer.shipped > 0 &&
    buyer.returned / buyer.shipped >= BUYER_MIN_RETURN_SHARE;

  const reasons: Array<'area' | 'buyer'> = [];
  if (chosen?.elevated) reasons.push('area');
  if (buyerElevated) reasons.push('buyer');

  const band: Band = reasons.length > 0 ? 'elevated' : chosen ? 'typical' : 'insufficient';
  const buyerOnly = reasons.length === 1 && reasons[0] === 'buyer';
  return {
    band,
    source: buyerOnly ? 'store' : (chosen?.scope ?? 'none'),
    n: buyerOnly ? buyer!.shipped : (chosen?.n ?? 0),
    rate: buyerOnly ? buyer!.returned / buyer!.shipped : (chosen?.rate ?? null),
    baselineRate: baseRate,
    areaKey,
    reasons,
    suggestions: band === 'elevated' ? ['confirm_by_phone', 'ask_instapay_deposit'] : [],
  };
}
