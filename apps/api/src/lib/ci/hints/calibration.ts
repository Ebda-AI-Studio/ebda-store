/**
 * Calibration (plan 4.3, Ruling CI-10): predicted band versus what actually happened, a weekly query over
 * `ci_hint_logs`. A band whose actual return rate is more than 10 points from the mean rate it predicted
 * (with at least 30 resolved hints) closes the feature's gate and alerts. Pure; the job supplies rows.
 */
export const CALIBRATION_MIN_RESOLVED = 30;
export const CALIBRATION_MAX_GAP = 0.1;

export interface CalibrationRow {
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
  for (const r of rows) {
    const k = `${r.feature}|${r.band}`;
    const m = merged.get(k) ?? { ...r, resolved: 0, returned: 0, predictedSum: 0 };
    m.resolved += r.resolved;
    m.returned += r.returned;
    m.predictedSum += r.predictedSum;
    merged.set(k, m);
  }
  return [...merged.values()]
    .sort((a, b) => `${a.feature}|${a.band}`.localeCompare(`${b.feature}|${b.band}`))
    .map(m => {
      const evaluated = m.resolved >= CALIBRATION_MIN_RESOLVED && m.band !== 'insufficient';
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
