import { describe, expect, it } from 'vitest';
import { planNamesJoined, wholesalePlanName, TRIAL_PLAN_CODE, planLabel } from '../plan-labels';
import { featureForStorePath } from '../route-feature-gates';
import ar from '../../i18n/messages/ar.json';
import en from '../../i18n/messages/en.json';

describe('plan names come from PLAN_LABELS (UX:C-5, QA P2-9)', () => {
  it('joins sold plan names per language', () => {
    expect(planNamesJoined(['growth', 'business'], 'en')).toBe('Growth and Business');
    expect(planNamesJoined(['growth', 'business'], 'ar')).toBe('النمو والأعمال');
  });
  it('wholesale is named from the plan limit table', () => {
    expect(wholesalePlanName('en')).toBe(planLabel('business', 'en'));
  });
  it('the trial plan is a sold plan', () => {
    expect(planLabel(TRIAL_PLAN_CODE, 'en')).toBe('Growth');
  });
  it('payment abandonments are plan-gated by the store layout (UX:S-6)', () => {
    expect(featureForStorePath('/stores/s1/payment-abandonments', 's1')).toBe(
      'payment_abandonment'
    );
  });
});

/** No admin message may type a sold plan's name; it takes a `{plan}` / `{plans}` placeholder. */
const NAMES =
  /(باقة|خطة|باقتي|باقة ال)\s*(Business|Growth|Basic|النمو|الأعمال|الاعمال|الأساسية)|\bthe (Business|Growth|Basic) plan\b|\b(Upgrade to|to|Included with|on the) (Business|Growth|Basic)\b|Growth and Business|على باقة النمو|Growth trial|باقتي النمو والأعمال/;
function walk(o: unknown, path: string, out: string[]) {
  if (typeof o === 'string') {
    if (NAMES.test(o)) out.push(`${path}: ${o}`);
  } else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k, out);
  }
}
// planLimit.* are server-side plan-limit sentences nothing in admin renders (checked by grep); listed here so the
// ratchet is honest rather than silent.
const DEAD = ['planLimit.'];
describe('no hard-coded plan names in admin messages', () => {
  for (const [lang, msgs] of [
    ['ar', ar],
    ['en', en],
  ] as const) {
    it(lang, () => {
      const hits: string[] = [];
      walk(msgs, '', hits);
      expect(hits.filter(h => !DEAD.some(d => h.startsWith(d)))).toEqual([]);
    });
  }
});
