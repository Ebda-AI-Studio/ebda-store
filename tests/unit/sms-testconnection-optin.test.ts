/**
 * SMS: real testConnection + opt-in gate
 *
 * Covers:
 *  1. SmsService.verifyCredentials — mocks the Unifonic Account/info endpoint.
 *     No real SMS is sent, no real network call is made.
 *  2. NotificationDispatcherService — promotional events are blocked when
 *     smsOptIn is false; transactional events always pass the gate.
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

// ─── Opt-in gate logic (pure unit — no Prisma, no Redis) ─────────────────────

/**
 * The dispatcher's opt-in check is: if isPromotionalSmsEvent && !data.smsOptIn → skip.
 * We test the SAME predicate in isolation to verify the gate logic without
 * spinning up the full dispatcher (which needs Redis + Prisma + feature flags).
 */
function shouldSkipSmsForOptin(event: string, smsOptIn: boolean | undefined): boolean {
  const isPromotional = PROMOTIONAL_SMS_EVENTS.has(event as never);
  return isPromotional && !smsOptIn;
}

describe('SMS opt-in gate predicate', () => {
  it('skips promotional SMS when smsOptIn is false', () => {
    expect(shouldSkipSmsForOptin('cart_abandoned_step1', false)).toBe(true);
    expect(shouldSkipSmsForOptin('back_in_stock', false)).toBe(true);
  });

  it('skips promotional SMS when smsOptIn is undefined (default/omitted)', () => {
    expect(shouldSkipSmsForOptin('cart_abandoned_step2', undefined)).toBe(true);
  });

  it('does NOT skip promotional SMS when smsOptIn is true', () => {
    expect(shouldSkipSmsForOptin('cart_abandoned_step3', true)).toBe(false);
    expect(shouldSkipSmsForOptin('back_in_stock', true)).toBe(false);
  });

  it('does NOT skip transactional events even when smsOptIn is false', () => {
    const transactional = [
      'order_confirmed',
      'payment_success',
      'order_shipped',
      'order_delivered',
      'order_cancelled',
      'refund_processed',
    ];

    for (const event of transactional) {
      expect(shouldSkipSmsForOptin(event, false)).toBe(
        false,
        `Transactional event ${event} should NOT be gated on smsOptIn`
      );
    }
  });

  it('does NOT skip transactional events when smsOptIn is undefined', () => {
    expect(shouldSkipSmsForOptin('order_shipped', undefined)).toBe(false);
    expect(shouldSkipSmsForOptin('order_confirmed', undefined)).toBe(false);
  });
});
