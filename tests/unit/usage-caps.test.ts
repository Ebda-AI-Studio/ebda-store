/**
 * Ruling PLANS-1 / G36: the production AI cap is 1800/day + 54000/month platform-wide, and no store slice may exceed
 * the platform ceiling. Fails on the old code (450/day, 150 store slice, daily cap scaled by key count).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveAiCaps } from '../../apps/api/src/lib/usage-caps';

const KEYS = [
  'AI_DAILY_REQUEST_CAP',
  'AI_MONTHLY_REQUEST_CAP',
  'AI_STORE_DAILY_REQUEST_CAP',
] as const;
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const clear = () => KEYS.forEach(k => delete process.env[k]);

describe('resolveAiCaps', () => {
  it('defaults to 1800/day, 54000/month, store slice 900 (50%)', () => {
    clear();
    expect(resolveAiCaps()).toEqual({ dailyCap: 1800, monthlyCap: 54000, storeDailyCap: 900 });
  });
  it('an explicit platform cap wins and the default store slice follows it', () => {
    clear();
    process.env.AI_DAILY_REQUEST_CAP = '1000';
    expect(resolveAiCaps()).toMatchObject({ dailyCap: 1000, storeDailyCap: 500 });
  });
  it('an explicit store slice can never exceed the platform daily cap', () => {
    clear();
    process.env.AI_STORE_DAILY_REQUEST_CAP = '99999';
    expect(resolveAiCaps().storeDailyCap).toBe(1800);
  });
  it('an explicit smaller store slice is honoured', () => {
    clear();
    process.env.AI_STORE_DAILY_REQUEST_CAP = '3';
    expect(resolveAiCaps().storeDailyCap).toBe(3);
  });
  it('a garbage env value falls back to the default instead of NaN', () => {
    clear();
    process.env.AI_DAILY_REQUEST_CAP = 'abc';
    expect(resolveAiCaps().dailyCap).toBe(1800);
  });
});
