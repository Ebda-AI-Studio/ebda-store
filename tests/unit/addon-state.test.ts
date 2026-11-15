/**
 * Add-on state model (docs/plans/2026-11-15-self-service-addons.md section 3). Each state has a case that fails when its
 * rule is broken; "pending never means on" is checked against the live feature gate in addon-entitlement-cache.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { deriveAddonState } from '@api/services/billing/addon-state';

type StateInput = Parameters<typeof deriveAddonState>[0];
const PENDING_FRESH_MS = 30 * 60_000;
const FAILED_VISIBLE_MS = 7 * 86_400_000;
const ENDED_VISIBLE_MS = 30 * 86_400_000;

const now = new Date('2026-11-15T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const base: StateInput = {
  renews: true,
  isFeature: true,
  running: null,
  onWithoutAddon: false,
  overrideOn: false,
  newest: null,
  now,
};
const row = (status: string, createdAgo: number, endAgo: number | null = null) => ({
  status,
  createdAt: ago(createdAgo),
  forPeriodEnd: endAgo === null ? null : ago(endAgo),
});

describe('deriveAddonState', () => {
  it('available: nothing happened', () => expect(deriveAddonState(base)).toBe('available'));

  it('renewing: a running feature term', () =>
    expect(deriveAddonState({ ...base, running: { endsAt: now, cancelAtPeriodEnd: false } })).toBe(
      'renewing'
    ));

  it('active: a running AI pack never "renews"', () =>
    expect(
      deriveAddonState({
        ...base,
        renews: false,
        isFeature: false,
        running: { endsAt: now, cancelAtPeriodEnd: false },
      })
    ).toBe('active'));

  it('cancelled_at_period_end: the cancel marker is on the running term', () =>
    expect(deriveAddonState({ ...base, running: { endsAt: now, cancelAtPeriodEnd: true } })).toBe(
      'cancelled_at_period_end'
    ));

  it('pending_payment only while fresh; a stale abandoned checkout returns Buy', () => {
    expect(deriveAddonState({ ...base, newest: row('pending', 60_000) })).toBe('pending_payment');
    expect(deriveAddonState({ ...base, newest: row('pending', PENDING_FRESH_MS + 1) })).toBe(
      'available'
    );
  });

  it('failed shows for 7 days, then available', () => {
    expect(deriveAddonState({ ...base, newest: row('failed', 1000) })).toBe('failed');
    expect(deriveAddonState({ ...base, newest: row('failed', FAILED_VISIBLE_MS + 1) })).toBe(
      'available'
    );
  });

  it('expired: the last paid term ended inside 30 days; older is available', () => {
    expect(deriveAddonState({ ...base, newest: row('succeeded', 40 * 86_400_000, 1000) })).toBe(
      'expired'
    );
    expect(
      deriveAddonState({
        ...base,
        newest: row('succeeded', 90 * 86_400_000, ENDED_VISIBLE_MS + 1),
      })
    ).toBe('available');
  });

  it('refunded: newest paid row refunded', () =>
    expect(deriveAddonState({ ...base, newest: row('refunded', 86_400_000, null) })).toBe(
      'refunded'
    ));

  it('included vs granted: the cause of an already-on feature', () => {
    expect(deriveAddonState({ ...base, onWithoutAddon: true })).toBe('included');
    expect(deriveAddonState({ ...base, onWithoutAddon: true, overrideOn: true })).toBe('granted');
  });

  it('a running paid term outranks included/granted and a newer failed attempt', () => {
    expect(
      deriveAddonState({
        ...base,
        onWithoutAddon: true,
        running: { endsAt: now, cancelAtPeriodEnd: false },
        newest: row('failed', 1000),
      })
    ).toBe('renewing');
  });

  it('an AI pack is never "included" even if a feature flag of the same name is on', () =>
    expect(
      deriveAddonState({ ...base, isFeature: false, renews: false, onWithoutAddon: true })
    ).toBe('available'));
});
