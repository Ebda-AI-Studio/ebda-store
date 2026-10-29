/**
 * Calibration (plan 4.3, Ruling CI-10): predicted band versus what actually happened, a weekly query over
 * `ci_hint_logs`. A band whose actual return rate is more than 10 points from the mean rate it predicted
 * (with at least 30 resolved hints) raises an alert; it NEVER closes the platform gate (Ruling CI-11: one
 * store feeding skewed outcomes must not switch a feature off for everyone; a super-admin decides).
 * A band is only evaluated under the cohort rules: >= 5 distinct stores, none above 40% of it.
 */
export const CALIBRATION_MIN_RESOLVED = 30;
export const CALIBRATION_MAX_GAP = 0.1;
export const CALIBRATION_MIN_STORES = 5;
export const CALIBRATION_MAX_STORE_SHARE = 0.4;

export interface CalibrationRow {
  storeId: string;
  feature: string;
  band: string;
  resolved: number;
  returned: number;
  predictedSum: number;
}
export interface CalibrationResult {
  feature: string;
  band: string;
  resolved: number;
  predicted: number | null;
  actual: number | null;
  evaluated: boolean;
  off: boolean;
}

export function evaluateCalibration(rows: CalibrationRow[]): CalibrationResult[] {
  const merged = new Map<string, CalibrationRow>();
  const perStore = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const k = `${r.feature}|${r.band}`;
    const ps = perStore.get(k) ?? new Map<string, number>();
    ps.set(r.storeId, (ps.get(r.storeId) ?? 0) + r.resolved);
    perStore.set(k, ps);
    const m = merged.get(k) ?? { ...r, resolved: 0, returned: 0, predictedSum: 0 };
    m.resolved += r.resolved;
    m.returned += r.returned;
    m.predictedSum += r.predictedSum;
    merged.set(k, m);
  }
  return [...merged.values()]
    .sort((a, b) => `${a.feature}|${a.band}`.localeCompare(`${b.feature}|${b.band}`))
    .map(m => {
      const ps = [...(perStore.get(`${m.feature}|${m.band}`)?.values() ?? [])];
      const kOk =
        ps.length >= CALIBRATION_MIN_STORES &&
        Math.max(0, ...ps) / Math.max(1, m.resolved) <= CALIBRATION_MAX_STORE_SHARE;
      const evaluated = m.resolved >= CALIBRATION_MIN_RESOLVED && kOk && m.band !== 'insufficient';
      const predicted = m.resolved > 0 ? m.predictedSum / m.resolved : null;
      const actual = m.resolved > 0 ? m.returned / m.resolved : null;
      return {
        feature: m.feature,
        band: m.band,
        resolved: m.resolved,
        predicted,
        actual,
        evaluated,
        off: evaluated && Math.abs(actual! - predicted!) > CALIBRATION_MAX_GAP,
      };
    });
}
