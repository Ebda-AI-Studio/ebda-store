/** CI-2 insights (guarded, rule-based) and CI-3 calibration (auto-disable at > 10 points). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const row = (
    band: string,
    resolved: number,
    returned: number,
    predicted: number,
    storeId = 's1'
  ) => ({
    storeId,
    feature: 'cod_risk',
    band,
    resolved,
    returned,
    predictedSum: predicted * resolved,
  });
  /** Spread over 5 stores so the cohort rules pass. */
  const spread = (band: string, perStore: number, returned: number, predicted: number) =>
    [1, 2, 3, 4, 5].map(i => row(band, perStore, returned, predicted, `s${i}`));
  it('under 30 resolved is not evaluated; the gap must exceed 10 points', () => {
    expect(evaluateCalibration(spread('elevated', 5, 5, 0.1))[0]).toMatchObject({
      evaluated: false,
    }); // 25 total
    expect(evaluateCalibration(spread('elevated', 6, 0, 0.1))[0]).toMatchObject({
      evaluated: true,
      off: true,
    }); // 30 total
    expect(evaluateCalibration(spread('elevated', 20, 2, 0.1))[0]).toMatchObject({ off: false }); // exactly 10 points
    expect(evaluateCalibration(spread('elevated', 20, 5, 0.1))[0]).toMatchObject({ off: true });
  });
  it('a below-k band is "not evaluated": under 5 stores, or one store above 40%', () => {
    expect(evaluateCalibration([row('elevated', 500, 500, 0.1)])[0]).toMatchObject({
      evaluated: false,
      off: false,
    });
    const four = [1, 2, 3, 4].map(i => row('elevated', 50, 50, 0.1, `s${i}`));
    expect(evaluateCalibration(four)[0]).toMatchObject({ evaluated: false, off: false });
    const skew = [
      row('elevated', 500, 500, 0.1, 's1'),
      ...[2, 3, 4, 5].map(i => row('elevated', 10, 1, 0.1, `s${i}`)),
    ];
    expect(evaluateCalibration(skew)[0]).toMatchObject({ evaluated: false, off: false });
  });
  it('rows from several stores merge before judging', () => {
    expect(evaluateCalibration(spread('typical', 8, 8, 0.1))).toHaveLength(1);
  });
  it('the insufficient band is never judged', () => {
    expect(evaluateCalibration(spread('insufficient', 50, 45, 0))[0]).toMatchObject({
      evaluated: false,
    });
  });
});

describe('runCalibration', () => {
  it('alerts for a mis-calibrated feature and leaves a calibrated one alone', async () => {
    const alert = vi.fn();
    const rows = (feature: string, returned: number) =>
      [1, 2, 3, 4, 5].map(i => ({
        storeId: `s${i}`,
        feature,
        band: 'elevated',
        resolved: 20,
        returned,
        predictedSum: 3,
      }));
    const out = await runCalibration({
      collect: async () => [...rows('cod_risk', 12), ...rows('courier', 3)],
      alert,
    });
    expect(out.alerted).toEqual(['cod_risk']);
    expect(alert).toHaveBeenCalledWith(
      'cod_risk',
      expect.stringContaining('predicted 15.0% vs actual 60.0%')
    );
  });

  it('one store feeding skewed outcomes alerts nobody and cannot close a platform gate', async () => {
    const alert = vi.fn();
    const out = await runCalibration({
      collect: async () => [
        {
          storeId: 'evil',
          feature: 'cod_risk',
          band: 'elevated',
          resolved: 500,
          returned: 500,
          predictedSum: 50,
        },
      ],
      alert,
    });
    expect(out.alerted).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
    const src = readFileSync(
      join(__dirname, '../../apps/api/src/services/ci-calibration.service.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/setGate|closeGate/);
  });
});
