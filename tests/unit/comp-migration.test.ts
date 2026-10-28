/** Amelia comp migration (EBDA-FUNNEL-19): the pure planner. Idempotent, refuses anything unsafe. */
import { describe, it, expect } from 'vitest';
import { planCompMigration } from '@api/services/billing/comp-migration';

const now = new Date('2026-10-26T10:00:00.000Z');
const future = new Date('2026-12-01T23:59:59.999Z');

describe('planCompMigration', () => {
  it('migrates a comped store onto Growth by InstaPay', () => {
    expect(planCompMigration({ planCode: 'comped', status: 'comped' }, future, now)).toEqual({
      action: 'migrate',
      from: { planCode: 'comped', status: 'comped' },
      to: { planCode: 'growth', status: 'active', billingMethod: 'instapay' },
    });
  });
  it('also migrates founding_free', () => {
    expect(
      planCompMigration({ planCode: 'founding_free', status: 'comped' }, future, now).action
    ).toBe('migrate');
  });
  it('is a no-op once she is on Growth (a second run changes nothing)', () => {
    expect(planCompMigration({ planCode: 'growth', status: 'active' }, future, now)).toEqual({
      action: 'noop',
      reason: 'already_migrated',
    });
  });
  it('refuses to touch any other paid or lapsed state', () => {
    for (const sub of [
      { planCode: 'business', status: 'active' },
      { planCode: 'basic', status: 'past_due' },
      { planCode: 'growth', status: 'trialing' },
      { planCode: 'growth', status: 'canceled' },
      { planCode: 'comped', status: 'active' },
    ]) {
      expect(planCompMigration(sub, future, now)).toEqual({
        action: 'refuse',
        reason: 'not_comped',
      });
    }
  });
  it('refuses a missing subscription', () => {
    expect(planCompMigration(null, future, now)).toEqual({
      action: 'refuse',
      reason: 'no_subscription',
    });
  });
  it('refuses a covered-until that is not in the future or not a date', () => {
    const comped = { planCode: 'comped', status: 'comped' };
    expect(planCompMigration(comped, now, now).action).toBe('refuse');
    expect(planCompMigration(comped, new Date('2026-01-01'), now).action).toBe('refuse');
    expect(planCompMigration(comped, new Date('nope'), now).action).toBe('refuse');
  });
  it('refuses a child store (included in its parent: it would never be billed)', () => {
    expect(planCompMigration({ planCode: 'comped', status: 'comped' }, future, now, false)).toEqual(
      {
        action: 'refuse',
        reason: 'child_store',
      }
    );
  });
});
