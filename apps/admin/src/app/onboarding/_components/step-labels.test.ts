import { describe, expect, it } from 'vitest';
import ar from '../../../i18n/messages/ar.json';
import en from '../../../i18n/messages/en.json';
import { STEP_ORDER } from './types';

describe('onboarding stepper labels (OB1)', () => {
  it.each([
    ['en', en],
    ['ar', ar],
  ] as const)('every step in the %s stepper has its own label', (_l, msgs) => {
    const steps = (msgs as unknown as { onboarding: { flow: { steps: Record<string, string> } } })
      .onboarding.flow.steps;
    const labels = STEP_ORDER.map(k => steps[k]);
    expect(labels.every(Boolean)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
