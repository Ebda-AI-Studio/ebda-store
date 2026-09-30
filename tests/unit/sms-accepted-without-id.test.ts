/**
 * Issue 2389: Unifonic answered 2xx with `success: true` (the message is
 * ACCEPTED — it will be delivered and billed) but no `data.messageId`.
 * `sendSms` used to throw, so the queue saw a failed send and retried: up to
 * maxAttempts real texts and real credits for one message. An accepted send is
 * a send; the missing id is reported as unknown (null), never as a failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { smsService } from '@api/services/sms.service';

const mockFetch = vi.fn();
global.fetch = mockFetch as typeof global.fetch;

const cfg = { appSid: 'sid', senderId: 'Store' };
const accepted = (body: unknown) =>
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => body } as Response);

describe('SmsService.sendSms — accepted without a messageId', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['empty data', { success: true, message: 'ok', data: {} }],
    ['no data', { success: true, message: 'ok' }],
    ['empty-string id', { success: true, message: 'ok', data: { messageId: '' } }],
  ])('%s → resolves as sent with an unknown (null) id, never throws', async (_n, body) => {
    accepted(body);
    await expect(smsService.sendSms(cfg, '+96512345678', 'hi')).resolves.toEqual({
      messageId: null,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the provider id when present', async () => {
    accepted({ success: true, message: 'ok', data: { messageId: 'u-1', status: 'Sent' } });
    await expect(smsService.sendSms(cfg, '+96512345678', 'hi')).resolves.toEqual({
      messageId: 'u-1',
    });
  });

  it('still throws when the provider rejects (success:false) — that one is retryable', async () => {
    accepted({ success: false, message: 'Invalid', errorCode: 'ER-01' });
    await expect(smsService.sendSms(cfg, '+96512345678', 'hi')).rejects.toThrow(/ER-01/);
  });
});
