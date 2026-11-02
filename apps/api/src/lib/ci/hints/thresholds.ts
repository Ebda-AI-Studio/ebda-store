/**
 * CI-3 thresholds (plan 4.1, Ruling CI-10): the ONE place that decides whether a cell may show a number
 * to a merchant. Everything in hints/ goes through `showable`; below it the UI says "not enough data yet",
 * never a guess or a rounded 0%.
 */
import { daysBetween, type Cell } from '../aggregate/cells';
import {
  COHORT_MAX_STORE_SHARE,
  COHORT_MIN_N,
  COHORT_MIN_STORES,
  type CohortCell,
  type Cohort,
  type StoreWindow,
} from '../aggregate/run';

/** Store-only cell: n >= 30 outcomes spread over at least 14 days (first and last day inclusive). */
export const STORE_MIN_N = 30;
export const STORE_MIN_SPAN_DAYS = 14;
/** Any hint: the aggregate behind it is at most this many days old. */
export const HINT_MAX_AGE_DAYS = 7;

export type Scope = 'store' | 'cohort';
export interface ViewCell {
  scope: Scope;
  n: number;
  hit: number;
  sum: number;
}

export const storeCellShowable = (c: Cell): boolean =>
  c.n >= STORE_MIN_N && daysBetween(c.first, c.last) + 1 >= STORE_MIN_SPAN_DAYS;

export const cohortCellShowable = (c: CohortCell): boolean =>
  c.n >= COHORT_MIN_N && c.stores >= COHORT_MIN_STORES && c.maxShare <= COHORT_MAX_STORE_SHARE;

export function aggregateFresh(asOf: string | undefined, now: Date): boolean {
  if (!asOf) return false;
  const age = (now.getTime() - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000;
  return age <= HINT_MAX_AGE_DAYS + 1; // asOf is a day's start; "7 days old" = within 7 full days of its end
}

/** What the hint functions read: the store's own 90-day window and the opted-in cohort, each possibly absent. */
export interface HintData {
  window: StoreWindow | null;
  cohort: Cohort | null;
  now: Date;
}

/** First cell of `keys` (most specific first) that may be shown, in one scope. Reapplies the thresholds on read. */
export function pickCell(
  data: HintData,
  scope: Scope,
  metric: keyof StoreWindow['own'],
  keys: string[]
): ViewCell | undefined {
  if (scope === 'store') {
    if (!data.window || !aggregateFresh(data.window.asOf, data.now)) return undefined;
    for (const k of keys) {
      const c = data.window.own[metric]?.[k];
      if (c && storeCellShowable(c)) return { scope, n: c.n, hit: c.hit, sum: c.sum };
    }
    return undefined;
  }
  if (!data.cohort || !aggregateFresh(data.cohort.asOf, data.now)) return undefined;
  for (const k of keys) {
    const c = data.cohort.metrics[metric]?.[k];
    if (c && !('suppressed' in c) && cohortCellShowable(c)) {
      return { scope, n: c.n, hit: c.hit, sum: c.sum };
    }
  }
  return undefined;
}

/** The platform baseline a rate is judged against: the cohort's cell when it may be shown, else the store's own. */
export function baselineCell(
  data: HintData,
  metric: keyof StoreWindow['own'],
  key: string
): ViewCell | undefined {
  return pickCell(data, 'cohort', metric, [key]) ?? pickCell(data, 'store', metric, [key]);
}
