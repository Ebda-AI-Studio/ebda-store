import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs ops script
import { evaluate, shortestExpiryDays } from '../../scripts/ops/check-log-retention.mjs';

const age = (days: number, extra: object = {}) => ({
  id: 'r',
  enabled: true,
  deleteObjectsTransition: { condition: { type: 'Age', maxAge: days * 86400 } },
  ...extra,
});

describe('log retention check (M-145)', () => {
  it('passes a 30 day whole-bucket rule', () => {
    expect(evaluate([age(30)]).ok).toBe(true);
  });
  it('fails when there is no rule', () => {
    expect(evaluate([]).ok).toBe(false);
    expect(evaluate(undefined).ok).toBe(false);
  });
  it('fails a rule longer than 30 days', () => {
    expect(evaluate([age(90)]).ok).toBe(false);
  });
  it('ignores disabled rules and prefix-only rules', () => {
    expect(shortestExpiryDays([age(7, { enabled: false })])).toBeNull();
    expect(shortestExpiryDays([age(7, { conditions: { prefix: 'a/' } })])).toBeNull();
  });
  it('takes the shortest of several', () => {
    expect(shortestExpiryDays([age(60), age(14)])).toBe(14);
  });
});
