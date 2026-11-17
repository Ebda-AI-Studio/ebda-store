/** QA-ONB-1: the stepper showed two steps both labelled "الدفع" (plan billing and customer payments). */
import { describe, it, expect } from 'vitest';
import en from '../../../i18n/messages/en.json';
import ar from '../../../i18n/messages/ar.json';
import { STEP_ORDER } from './types';

const stepsOf = (messages: unknown) =>
  (messages as { onboarding: { flow: { steps: Record<string, string> } } }).onboarding.flow.steps;

describe('onboarding stepper labels', () => {
  for (const [name, messages] of [
    ['ar', ar],
    ['en', en],
  ] as const) {
    const steps = (
      messages as unknown as { onboarding: { flow: { steps: Record<string, string> } } }
    ).onboarding.flow.steps;
    it(`${name}: every step has a label and no two steps share one`, () => {
      const labels = STEP_ORDER.map(k => steps[k]?.trim());
      expect(labels.every(Boolean)).toBe(true);
      expect(new Set(labels).size).toBe(labels.length);
    });
  }

  it('the two payment steps say which payment they mean', () => {
    const a = stepsOf(ar);
    const e = stepsOf(en);
    expect([a.billing, a.payment]).toEqual(['دفع الباقة', 'طرق دفع عملائك']);
    expect([e.billing, e.payment]).toEqual(['Plan payment', 'Customer payments']);
  });
});
