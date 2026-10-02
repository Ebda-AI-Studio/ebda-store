/**
 * Email campaigns (D2) — the one-click unsubscribe token. A token that
 * verifies after tampering would let anyone unsubscribe anyone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'crypto';

const cfg = vi.hoisted(() => ({
  jwtSecret: 'test-jwt-secret',
  encryptionKey: 'test-encryption-key-0123456789abcdef',
}));
vi.mock('@api/config', () => ({ config: cfg }));

import { signUnsubscribeToken, verifyUnsubscribeToken } from '@api/lib/campaign-unsubscribe-token';

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER_STORE = '22222222-2222-4222-8222-222222222222';
const RECIPIENT = '33333333-3333-4333-8333-333333333333';
const OTHER_RECIPIENT = '44444444-4444-4444-8444-444444444444';

afterEach(() => {
  delete process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
  cfg.jwtSecret = 'test-jwt-secret';
  cfg.encryptionKey = 'test-encryption-key-0123456789abcdef';
});

/** A token exactly as the pre-issue-2424 code signed it: keyed on JWT_SECRET. */
function legacyToken(storeId: string, recipientId: string, jwtSecret: string): string {
  const sig = createHmac('sha256', jwtSecret)
    .update(`campaign-unsubscribe:v1:${storeId}:${recipientId}`)
    .digest('base64url');
  return `${storeId}.${recipientId}.${sig}`;
}

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

  describe('key — not the session secret (issue 2424)', () => {
    it('a new link survives a JWT_SECRET rotation', () => {
      const token = signUnsubscribeToken(STORE, RECIPIENT);
      cfg.jwtSecret = 'rotated-session-secret';
      expect(verifyUnsubscribeToken(token)).toEqual({ storeId: STORE, recipientId: RECIPIENT });
    });

    it('a new link is not signed with JWT_SECRET at all', () => {
      expect(signUnsubscribeToken(STORE, RECIPIENT)).not.toBe(
        legacyToken(STORE, RECIPIENT, cfg.jwtSecret)
      );
    });

    it('a link signed before the change (JWT_SECRET) still verifies', () => {
      expect(verifyUnsubscribeToken(legacyToken(STORE, RECIPIENT, cfg.jwtSecret))).toEqual({
        storeId: STORE,
        recipientId: RECIPIENT,
      });
    });

    it('with a dedicated secret set, only that secret verifies', () => {
      process.env.CAMPAIGN_UNSUBSCRIBE_SECRET = 'dedicated-secret';
      const token = signUnsubscribeToken(STORE, RECIPIENT);
      expect(verifyUnsubscribeToken(token)).not.toBeNull();
      expect(verifyUnsubscribeToken(legacyToken(STORE, RECIPIENT, cfg.jwtSecret))).toBeNull();
    });
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
