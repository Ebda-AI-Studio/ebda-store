/**
 * Every analytics period the admin can hold has a subtitle in BOTH locales.
 *
 * The Sales Overview subtitle is `t(period)` over `analytics.periodsSubtitle`
 * — a VARIABLE argument, so the static i18n sweeps (which check literal
 * `t('key')` calls) cannot see it. When the 9-preset picker shipped, the
 * default became `this_month` and no key existed for it or any other new
 * preset: the card rendered the raw key `analytics.periodsSubtitle.this_month`
 * on every store (2026-09-30 audit, finding 1).
 *
 * A parity check (en vs ar) would have passed: the keys were missing from
 * BOTH. So the checklist here is the ENUM (`ANALYTICS_PERIODS` from
 * @force/shared, the same list the API validates and the picker renders), and
 * each id must resolve to a non-empty string in each locale. Same for the
 * sales-chart granularity labels (`analytics.chart.granularity.*`).
 *
 * Mutation proof: delete `this_month` from ar.json's periodsSubtitle → red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  ANALYTICS_PERIODS,
  ANALYTICS_PERIOD_PRESETS,
  SALES_GRANULARITIES,
} from '../../packages/shared/src/schemas/analytics';

const MESSAGES = resolve(__dirname, '../../apps/admin/src/i18n/messages');
const locales = {
  en: JSON.parse(readFileSync(resolve(MESSAGES, 'en.json'), 'utf8')),
  ar: JSON.parse(readFileSync(resolve(MESSAGES, 'ar.json'), 'utf8')),
};

describe('analytics period subtitles — enum-as-checklist', () => {
  it('the picker offers exactly the 9 presets', () => {
    expect(ANALYTICS_PERIOD_PRESETS).toHaveLength(9);
  });

  for (const [loc, messages] of Object.entries(locales)) {
    for (const period of ANALYTICS_PERIODS) {
      it(`${loc}: analytics.periodsSubtitle.${period}`, () => {
        const value = messages.analytics?.periodsSubtitle?.[period];
        expect(typeof value, `${loc} periodsSubtitle.${period}`).toBe('string');
        expect(value.trim().length).toBeGreaterThan(0);
      });
    }
    for (const g of SALES_GRANULARITIES) {
      it(`${loc}: analytics.chart.granularity.${g}`, () => {
        const value = messages.analytics?.chart?.granularity?.[g];
        expect(typeof value).toBe('string');
        expect(value.trim().length).toBeGreaterThan(0);
      });
    }
  }
});
