/**
 * Email campaigns (D2) — the one-click unsubscribe token. A token that
 * verifies after tampering would let anyone unsubscribe anyone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@api/config', () => ({ config: { jwtSecret: 'test-jwt-secret' } }));

import { signUnsubscribeToken, verifyUnsubscribeToken } from '@api/lib/campaign-unsubscribe-token';

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER_STORE = '22222222-2222-4222-8222-222222222222';
const RECIPIENT = '33333333-3333-4333-8333-333333333333';
const OTHER_RECIPIENT = '44444444-4444-4444-8444-444444444444';

afterEach(() => {
  delete process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
});

describe('campaign unsubscribe token', () => {
  it('round-trips the ids it was signed for', () => {
    const token = signUnsubscribeToken(STORE, RECIPIENT);
    expect(verifyUnsubscribeToken(token)).toEqual({ storeId: STORE, recipientId: RECIPIENT });
  });

  it('carries no email address', () => {
    expect(signUnsubscribeToken(STORE, RECIPIENT)).not.toContain('@');
  });

  it('rejects a token whose store was swapped (cross-tenant replay)', () => {
    const sig = signUnsubscribeToken(STORE, RECIPIENT).split('.')[2];
    expect(verifyUnsubscribeToken(`${OTHER_STORE}.${RECIPIENT}.${sig}`)).toBeNull();
  });

  it('rejects a token whose recipient was swapped', () => {
    const sig = signUnsubscribeToken(STORE, RECIPIENT).split('.')[2];
    expect(verifyUnsubscribeToken(`${STORE}.${OTHER_RECIPIENT}.${sig}`)).toBeNull();
  });

  it('rejects a flipped signature character', () => {
    const token = signUnsubscribeToken(STORE, RECIPIENT);
    const last = token.slice(-1);
    const flipped = token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(verifyUnsubscribeToken(flipped)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    process.env.CAMPAIGN_UNSUBSCRIBE_SECRET = 'attacker-secret';
    const forged = signUnsubscribeToken(STORE, RECIPIENT);
    delete process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'a.b',
    'a.b.c.d',
    `${STORE}.${RECIPIENT}.short`,
    'x'.repeat(500),
  ])('rejects malformed input %#', input => {
    expect(verifyUnsubscribeToken(input)).toBeNull();
  });
});
