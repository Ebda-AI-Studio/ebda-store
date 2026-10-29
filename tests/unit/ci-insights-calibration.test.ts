/** CI-2 insights (guarded, rule-based) and CI-3 calibration (auto-disable at > 10 points). */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));

import { generateInsights } from '../../apps/api/src/lib/ci/aggregate/insights';
import type { Cohort } from '../../apps/api/src/lib/ci/aggregate/run';
import { evaluateCalibration } from '../../apps/api/src/lib/ci/hints/calibration';
import { runCalibration } from '../../apps/api/src/services/ci-calibration.service';

const pub = (n: number, hit: number, sum = 0) => ({ n, hit, sum, stores: 6, maxShare: 0.3 });
const cohort = (m: Partial<Cohort['metrics']>): Cohort => ({
  v: 1,
  asOf: '2026-11-09',
  windowDays: 90,
  metrics: {
    return_rate: {},
    delivery_hours: {},
    cod_confirmation: {},
    cod_return_by_amount: {},
    ...m,
  },
});

describe('generateInsights', () => {
  it('flags a carrier x area return rate clearly above the carrier baseline, with its n', () => {
    const out = generateInsights(
      cohort({
        return_rate: {
          'aramex|*': pub(1000, 100),
          'aramex|EG-G': pub(300, 60),
          'aramex|EG-C': pub(300, 30),
        },
      })
    );
    expect(out.map(o => o.dedupeKey)).toEqual(['return_rate:elevated:aramex|EG-G']);
    expect(out[0]!.evidence).toMatchObject({ n: 300, stores: 6, rate: 0.2, baselineRate: 0.1 });
    expect(out[0]!.findingAr).toContain('EG-G');
  });
  it('never reads a suppressed cell', () => {
    expect(
      generateInsights(
        cohort({
          return_rate: { 'aramex|*': pub(1000, 100), 'aramex|EG-G': { suppressed: true } } as never,
        })
      )
    ).toEqual([]);
  });
  it('slow delivery needs 1.5x the carrier mean; low COD confirmation and an amount band are found', () => {
    const slow = generateInsights(
      cohort({
        delivery_hours: {
          'bosta|*': pub(1000, 1000, 1000 * 20),
          'bosta|EG-A': pub(200, 200, 200 * 31),
        },
      })
    );
    expect(slow.map(s => s.metric)).toEqual(['delivery_hours']);
    expect(
      generateInsights(
        cohort({
          delivery_hours: {
            'bosta|*': pub(1000, 1000, 20_000),
            'bosta|EG-A': pub(200, 200, 200 * 29),
          },
        })
      )
    ).toEqual([]);
    const cod = generateInsights(
      cohort({ cod_confirmation: { '*': pub(1000, 800), 'EG-S': pub(300, 150) } })
    );
    expect(cod.map(c => c.dedupeKey)).toEqual(['cod_confirmation:low:EG-S']);
    const amt = generateInsights(
      cohort({ cod_return_by_amount: { '*': pub(1000, 100), b4: pub(150, 45), b1: pub(300, 30) } })
    );
    expect(amt.map(c => c.cohort)).toEqual(['b4']);
  });
  it('a cohort carrying a personal-looking key is refused, not trimmed', () => {
    expect(() =>
      generateInsights(
        cohort({ return_rate: { 'aramex|*': { ...pub(1000, 100), buyerKey: 'x' } } as never })
      )
    ).toThrow(/forbidden key/);
  });
});

describe('evaluateCalibration', () => {
  const row = (band: string, resolved: number, returned: number, predicted: number) => ({
    feature: 'cod_risk',
    band,
    resolved,
    returned,
    predictedSum: predicted * resolved,
  });
  it('29 resolved is not evaluated; 30 is; the gap must exceed 10 points', () => {
    expect(evaluateCalibration([row('elevated', 29, 29, 0.1)])[0]).toMatchObject({
      evaluated: false,
      off: false,
    });
    expect(evaluateCalibration([row('elevated', 30, 3, 0.1)])[0]).toMatchObject({
      evaluated: true,
      off: false,
    }); // actual 10% = predicted
    expect(evaluateCalibration([row('elevated', 100, 20, 0.1)])[0]).toMatchObject({ off: false }); // exactly 10 points
    expect(evaluateCalibration([row('elevated', 100, 21, 0.1)])[0]).toMatchObject({ off: true });
    expect(evaluateCalibration([row('elevated', 100, 0, 0.12)])[0]).toMatchObject({
      off: true,
      actual: 0,
    });
  });
  it('rows from several stores merge before judging', () => {
    const r = evaluateCalibration([row('typical', 20, 10, 0.1), row('typical', 20, 10, 0.1)]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ resolved: 40, evaluated: true, off: true });
  });
  it('the insufficient band is never judged', () => {
    expect(evaluateCalibration([row('insufficient', 100, 90, 0)])[0]).toMatchObject({
      evaluated: false,
    });
  });
});

describe('runCalibration', () => {
  it('closes the gate of a feature that is off and alerts; leaves a calibrated one alone', async () => {
    const closeGate = vi.fn();
    const alert = vi.fn();
    const out = await runCalibration({
      collect: async () => [
        { feature: 'cod_risk', band: 'elevated', resolved: 100, returned: 60, predictedSum: 15 },
        { feature: 'courier', band: 'typical', resolved: 100, returned: 10, predictedSum: 10 },
      ],
      closeGate,
      alert,
    });
    expect(out.closed).toEqual(['cod_risk']);
    expect(closeGate).toHaveBeenCalledWith(
      'cod_risk',
      expect.stringContaining('predicted 15.0% vs actual 60.0%')
    );
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
