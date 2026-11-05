/**
 * Courier suggestion (plan 4.2 #2, Ruling CI-10): ranks the merchant's enabled carriers by delivered rate
 * (then hours) for the destination area, store-only first, cohort when the threshold holds. The
 * merchant's choice is always one click and the default stays what they last used: this only returns a
 * ranking and, when at least two carriers can be compared, which one leads.
 */
import { areaLevels, cellKey } from '../aggregate/cells';
import { pickCell, type HintData, type Scope } from './thresholds';

export interface CourierRow {
  carrier: string;
  status: 'ok' | 'insufficient';
  deliveredRate?: number;
  meanHours?: number | null;
  n?: number;
  scope?: Scope;
}
export interface CourierSuggestion {
  ranked: CourierRow[];
  suggested: string | null;
}

export function rankCouriers(
  data: HintData,
  areaKey: string | null,
  carriers: string[]
): CourierSuggestion {
  const levels = areaLevels(areaKey);
  const rows: CourierRow[] = carriers.map(carrier => {
    const keys = levels.map(a => cellKey(carrier, a));
    for (const scope of ['store', 'cohort'] as const) {
      const c = pickCell(data, scope, 'return_rate', keys);
      if (!c) continue;
      const hours = pickCell(data, scope, 'delivery_hours', keys);
      return {
        carrier,
        status: 'ok',
        deliveredRate: 1 - c.hit / c.n,
        meanHours: hours ? hours.sum / hours.n : null,
        n: c.n,
        scope,
      };
    }
    return { carrier, status: 'insufficient' };
  });
  const ok = rows
    .filter(r => r.status === 'ok')
    .sort(
      (a, b) =>
        b.deliveredRate! - a.deliveredRate! ||
        (a.meanHours ?? Infinity) - (b.meanHours ?? Infinity) ||
        a.carrier.localeCompare(b.carrier)
    );
  const rest = rows.filter(r => r.status !== 'ok');
  return { ranked: [...ok, ...rest], suggested: ok.length >= 2 ? ok[0]!.carrier : null };
}
