/** Pure helpers for the dashboard's period numbers (tested in pulse-format.test.ts). */

type DeltaTone = 'up' | 'down' | 'flat';

export interface Delta {
  tone: DeltaTone;
  /** Absolute percent, already pct for display (0 when flat). */
  percent: number;
}

/** A "vs the previous period" change as a tone + pct percent; `null` when the API gave no usable number. */
export function toDelta(change: number | null | undefined): Delta | null {
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
