/**
 * StoreMailer paths on the Cloudflare Email Service binding.
 *
 * - sendBrandedBatch: each address is its OWN message (the legacy broadcast once put a 50-address
 *   chunk in one `to:` header); a failure stops the batch and reports the partial result.
 * - sendMarketingEmail: one address, our List-Unsubscribe headers, sender `<prefix>.<slug>@ebda.app`.
 * - sendBrandedEmail: the store's Reply-To (or the per-message one) and the sender resolution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send, findUnique } = vi.hoisted(() => ({ send: vi.fn(), findUnique: vi.fn() }));

vi.mock('@ebda/database', () => {
  const prisma = { store: { findUnique } };
  return { prisma, withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(prisma) };
});
vi.mock('@api/lib/store-operational', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/store-operational')>()),
  storeOperational: async () => true,
  storeMayMessageCustomers: async () => true,
  assertStoreOperational: async () => undefined,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { StoreMailer } from '@api/services/store-mailer.service';
import { EmailSendError } from '@api/services/mail-transport';

const STORE = {
  id: 's1',
  name: 'Shop',
  slug: 'shop',
  domain: null,
  email: 'owner@shop.test',
  emailSenderLocalPart: null,
  emailDomainStatus: null,
};

beforeEach(() => {
  send.mockReset();
  clearCfBindings();
  setCfBindings({ EMAIL: { send } });
  findUnique.mockReset().mockResolvedValue(STORE);
});

describe('sendBrandedBatch', () => {
  it('sends one email per address, no address ever sees another', async () => {
    send
      .mockResolvedValueOnce({ messageId: '1' })
      .mockResolvedValueOnce({ messageId: '2' })
      .mockResolvedValueOnce({ messageId: '3' });
    const to = ['a@x.test', 'b@x.test', 'c@x.test'];
    const { ids, error } = await StoreMailer.sendBrandedBatch('s1', {
      subject: 'S',
      messages: to.map(t => ({ to: t, html: '<p/>' })),
    });
    expect(send).toHaveBeenCalledTimes(3);
    const payloads = send.mock.calls.map(c => c[0] as { to: string; cc?: unknown; bcc?: unknown });
    expect(payloads.map(p => p.to)).toEqual(to);
    expect(payloads.every(p => p.cc === undefined && p.bcc === undefined)).toBe(true);
    expect(ids).toEqual(['1', '2', '3']);
    expect(error).toBeUndefined();
  });

  it('a failure stops the batch and reports what was sent', async () => {
    send
      .mockResolvedValueOnce({ messageId: '1' })
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'E_RATE_LIMIT_EXCEEDED' }));
    const r = await StoreMailer.sendBrandedBatch('s1', {
      subject: 'S',
      messages: ['a@x.test', 'b@x.test', 'c@x.test'].map(t => ({ to: t, html: '<p/>' })),
    });
    expect(r).toEqual({ ids: ['1'], error: 'E_RATE_LIMIT_EXCEEDED' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('refuses more than 100 per batch', async () => {
    const to = Array.from({ length: 101 }, (_, i) => `u${i}@x.test`);
    await expect(
      StoreMailer.sendBrandedBatch('s1', {
        subject: 'S',
        messages: to.map(t => ({ to: t, html: '<p/>' })),
      })
    ).rejects.toThrow(/at most 100/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('sendMarketingEmail', () => {
  it('sends to exactly one address with the headers and the store sender', async () => {
    send.mockResolvedValue({ messageId: 'm1' });
    const headers = { 'List-Unsubscribe': '<https://api.test/u>' };
    const r = await StoreMailer.sendMarketingEmail(STORE, {
      to: 'a@x.test',
      subject: 'S',
      html: '<p/>',
      headers,
      idempotencyKey: 'campaign-recipient/r1',
    });
    expect(r).toEqual({ id: 'm1' });
    const payload = send.mock.calls[0]![0];
    expect(payload.to).toBe('a@x.test');
    expect(payload.headers).toEqual(headers);
    expect(payload.from).toEqual({ email: 'orders.shop@ebda.app', name: 'Shop' });
    expect(payload.replyTo).toBe('owner@shop.test');
    expect(payload).not.toHaveProperty('idempotencyKey');
  });

  it('surfaces the provider code so a throttle can be told from a bad address', async () => {
    send.mockRejectedValue(Object.assign(new Error('slow'), { code: 'E_RATE_LIMIT_EXCEEDED' }));
    const err = await StoreMailer.sendMarketingEmail(STORE, {
      to: 'a@x.test',
      subject: 'S',
      html: '<p/>',
    }).catch(e => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.isRateLimit).toBe(true);
    expect(err.permanent).toBe(false);
  });
});

describe('sendBrandedEmail', () => {
  it('uses the per-message reply-to over the store default, and fails for an unknown store', async () => {
    send.mockResolvedValue({ messageId: 'e1' });
    await StoreMailer.sendBrandedEmail('s1', {
      to: 'c@x.test',
      subject: 'S',
      html: '<p/>',
      replyTo: 'shopper@x.test',
    });
    expect(send.mock.calls[0]![0].replyTo).toBe('shopper@x.test');
    findUnique.mockResolvedValue(null);
    await expect(
      StoreMailer.sendBrandedEmail('nope', { to: 'a@b.c', subject: 's', html: '<p/>' })
    ).rejects.toThrow(/not found/);
  });
});
