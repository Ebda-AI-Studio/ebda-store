/**
 * SMS: real testConnection + opt-in gate
 *
 * Covers:
 *  1. SmsService.verifyCredentials — mocks the Unifonic Account/info endpoint.
 *     No real SMS is sent, no real network call is made.
 *  2. The promotional/transactional event split. The consent gate itself is
 *     tested against Postgres in tests/integration/sms-marketing-consent.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { smsService } from '@api/services/sms.service';
import { PROMOTIONAL_SMS_EVENTS } from '@api/services/notification-dispatcher.service';

// ─── Mock fetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
global.fetch = mockFetch as typeof global.fetch;

// ─── SmsService.verifyCredentials ────────────────────────────────────────────

describe('SmsService.verifyCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok:true when Unifonic returns success:true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        message: 'Account info',
        data: { AppName: 'TestApp', AppStatus: 'Active', Balance: 100, CurrencyCode: 'USD' },
      }),
    } as Response);

    const result = await smsService.verifyCredentials({
      appSid: 'test-app-sid',
      senderId: 'TestSender',
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    // Verify it called Account/info (read-only endpoint), not the send endpoint
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).toContain('/Account/info');
    expect(url).not.toContain('/SMS/messages');
  });

  it('returns ok:false when Unifonic returns success:false (invalid AppSid)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: false,
        message: 'Invalid AppSid',
        errorCode: 'ER-04',
      }),
    } as Response);

    const result = await smsService.verifyCredentials({
      appSid: 'bad-sid',
      senderId: 'TestSender',
    });

    expect(result.ok).toBe(false);
    // Error message must NOT contain the actual credential value
    expect(result.reason).toBeDefined();
    expect(result.reason).not.toContain('bad-sid');
    // But it may surface the provider's error code (not a secret)
    expect(result.reason).toContain('ER-04');
  });

  it('returns ok:false when provider HTTP status is non-2xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({}),
    } as Response);

    const result = await smsService.verifyCredentials({
      appSid: 'any-sid',
      senderId: 'TestSender',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('401');
    // Must not expose the credential
    expect(result.reason).not.toContain('any-sid');
  });

  it('returns ok:false on network error (fetch rejects)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await smsService.verifyCredentials({
      appSid: 'any-sid',
      senderId: 'TestSender',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('SMS provider');
    // Must not leak the credential value in the error
    expect(result.reason).not.toContain('any-sid');
  });

  it('returns ok:false immediately when appSid is missing (no network call)', async () => {
    const result = await smsService.verifyCredentials({
      appSid: '',
      senderId: 'TestSender',
    });

    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns ok:false immediately when senderId is missing (no network call)', async () => {
    const result = await smsService.verifyCredentials({
      appSid: 'valid-sid',
      senderId: '',
    });

    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns ok:false when provider response JSON is not parseable', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);

    const result = await smsService.verifyCredentials({
      appSid: 'any-sid',
      senderId: 'TestSender',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unreadable');
  });
});

// ─── PROMOTIONAL_SMS_EVENTS set ──────────────────────────────────────────────

describe('PROMOTIONAL_SMS_EVENTS classification', () => {
  it('classifies cart_abandoned_step1/2/3 as promotional', () => {
    expect(PROMOTIONAL_SMS_EVENTS.has('cart_abandoned_step1')).toBe(true);
    expect(PROMOTIONAL_SMS_EVENTS.has('cart_abandoned_step2')).toBe(true);
    expect(PROMOTIONAL_SMS_EVENTS.has('cart_abandoned_step3')).toBe(true);
  });

  it('classifies back_in_stock as promotional', () => {
    expect(PROMOTIONAL_SMS_EVENTS.has('back_in_stock')).toBe(true);
  });

  it('does NOT classify transactional events as promotional', () => {
    const transactional = [
      'order_confirmed',
      'payment_success',
      'order_shipped',
      'order_delivered',
      'order_cancelled',
      'refund_processed',
    ] as const;

    for (const event of transactional) {
      expect(PROMOTIONAL_SMS_EVENTS.has(event)).toBe(
        false,
        `Expected ${event} to be transactional (not in PROMOTIONAL_SMS_EVENTS)`
      );
    }
  });
});

// ─── Opt-in gate ─────────────────────────────────────────────────────────────
//
// The promotional-SMS gate no longer reads a `smsOptIn` flag from the caller
// (no producer ever set one, issue 206). It reads the per-store consent row
// for the recipient's phone. The real gate — dispatcher + Postgres — is
// covered, and mutation-proven, in tests/integration/sms-marketing-consent.test.ts.
// The local re-implementation of the predicate that used to live here tested
// a copy of the code, not the code, so it is gone.
