/** Pure helpers for the dashboard's period numbers (tested in pulse-format.test.ts). */

type DeltaTone = 'up' | 'down' | 'flat' | 'new';

export interface Delta {
  tone: DeltaTone;
  /** Absolute percent, already pct for display (0 when flat). */
  percent: number;
}

/** A "vs the previous period" change as a tone + pct percent; `null` when the API gave no usable number. */
export function toDelta(
  change: number | null | undefined,
  /** Previous-period and current-period totals; the API reports +100% when previous = 0, which is not a percentage. */
  basis?: { previous?: number | null; current?: number | null }
): Delta | null {
  if (basis?.previous === 0) {
    // Nothing to compare against: "new" when there is something now, otherwise no delta at all.
    return (basis.current ?? 0) > 0 ? { tone: 'new', percent: 0 } : null;
  }
  if (change === null || change === undefined || !Number.isFinite(change)) return null;
  const pct = Math.round(Math.abs(change));
  if (pct === 0) return { tone: 'flat', percent: 0 };
  return { tone: change > 0 ? 'up' : 'down', percent: pct };
}

/** Bar heights (0..1) for a sparkline; a flat or empty series draws a flat baseline, never NaN. */
export function sparkBars(values: number[]): number[] {
  const max = Math.max(0, ...values);
  if (max <= 0) return values.map(() => 0);
  return values.map(v => Math.max(0, v) / max);
}
