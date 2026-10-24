/**
 * ResendService marketing paths (D2).
 *
 * - sendBrandedBatch: the legacy newsletter broadcast used to put a whole
 *   50-address chunk in ONE email's `to:` header, disclosing every subscriber
 *   to every other. Each address must now be its own email.
 * - sendMarketingEmail: one address, our headers, and the idempotency key
 *   passed through to Resend.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { emailsSend, batchSend, findUnique } = vi.hoisted(() => ({
  emailsSend: vi.fn(),
  batchSend: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: emailsSend };
    batch = { send: batchSend };
  },
}));
vi.mock('@ebda/database', () => {
  const prisma = { store: { findUnique } };
  return { prisma, withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(prisma) };
});
vi.mock('@api/config', () => ({ config: { resendApiKey: 're_test', emailProvider: 'resend' } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ResendService } from '@api/services/resend.service';
import { EmailSendError as ResendSendError } from '@api/services/mail-transport';

const STORE = {
  id: 's1',
  name: 'Shop',
  domain: null,
  email: 'owner@shop.test',
  emailSenderLocalPart: null,
  emailDomainStatus: null,
};

beforeEach(() => {
  emailsSend.mockReset();
  batchSend.mockReset();
  findUnique.mockReset().mockResolvedValue(STORE);
});

describe('sendBrandedBatch', () => {
  it('sends one email per address — no address ever sees another', async () => {
    emailsSend
      .mockResolvedValueOnce({ data: { id: '1' }, error: null })
      .mockResolvedValueOnce({ data: { id: '2' }, error: null })
      .mockResolvedValueOnce({ data: { id: '3' }, error: null });
    const to = ['a@x.test', 'b@x.test', 'c@x.test'];

    const { ids } = await ResendService.sendBrandedBatch('s1', {
      subject: 'S',
      messages: to.map(t => ({ to: t, html: '<p/>' })),
    });

    expect(emailsSend).toHaveBeenCalledTimes(3);
    const payload = emailsSend.mock.calls.map(
      c => c[0] as { to: string[]; bcc?: unknown; cc?: unknown }
    );
    expect(payload.map(p => p.to)).toEqual([['a@x.test'], ['b@x.test'], ['c@x.test']]);
    expect(payload.every(p => p.cc === undefined && p.bcc === undefined)).toBe(true);
    expect(ids).toEqual(['1', '2', '3']);
  });

  it('refuses more than 100 per batch', async () => {
    const to = Array.from({ length: 101 }, (_, i) => `u${i}@x.test`);
    await expect(
      ResendService.sendBrandedBatch('s1', {
        subject: 'S',
        messages: to.map(t => ({ to: t, html: '<p/>' })),
      })
    ).rejects.toThrow(/at most 100/);
    expect(emailsSend).not.toHaveBeenCalled();
  });
});

describe('sendMarketingEmail', () => {
  it('sends to exactly one address with the headers and idempotency key', async () => {
    emailsSend.mockResolvedValue({ data: { id: 'm1' }, error: null });
    const headers = { 'List-Unsubscribe': '<https://api.test/u>' };

    await ResendService.sendMarketingEmail(STORE, {
      to: 'a@x.test',
      subject: 'S',
      html: '<p/>',
      headers,
      idempotencyKey: 'campaign-recipient/r1',
    });

    const [payload, options] = emailsSend.mock.calls[0];
    expect(payload.to).toEqual(['a@x.test']);
    expect(payload.headers).toEqual(headers);
    expect(payload.from).toBe('Shop <no-reply@ebda.app>');
    expect(options).toEqual({ idempotencyKey: 'campaign-recipient/r1' });
  });

  it('surfaces the provider error name so a 429 can be told from a bad address', async () => {
    emailsSend.mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'Too many requests' },
    });
    const err = await ResendService.sendMarketingEmail(STORE, {
      to: 'a@x.test',
      subject: 'S',
      html: '<p/>',
    }).catch(e => e);
    expect(err).toBeInstanceOf(ResendSendError);
    expect(err.code).toBe('rate_limit_exceeded');
  });
});
