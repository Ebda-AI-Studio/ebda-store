/**
 * Ruling PLANS-1 / G36: the production AI cap is 1800/day + 54000/month platform-wide, the store BASE slice stays 150
 * (top-ups sell the room up to the 50% share), and no store slice may exceed the platform ceiling. Fails on the old code (450/day, 150 store slice, daily cap scaled by key count).
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
  it('defaults to 1800/day, 54000/month, store base slice 150', () => {
    clear();
    expect(resolveAiCaps()).toEqual({ dailyCap: 1800, monthlyCap: 54000, storeDailyCap: 150 });
  });
  it('the store base stays BELOW the 50% store share, so an AI top-up can be backed (G36)', () => {
    clear();
    const { dailyCap, storeDailyCap } = resolveAiCaps();
    expect(storeDailyCap + 300).toBeLessThanOrEqual(Math.floor(dailyCap / 2)); // the smallest pack fits the share
  });
  it('an explicit platform cap wins; a tiny platform cap clamps the store base', () => {
    clear();
    process.env.AI_DAILY_REQUEST_CAP = '100';
    expect(resolveAiCaps()).toMatchObject({ dailyCap: 100, storeDailyCap: 100 });
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
