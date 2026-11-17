/**
 * Ruling WA-LEGACY-1: the email layer refuses to send to a reserved-TLD address (a placeholder can
 * never deliver). Covers the helper and the real StoreMailer send path with the Cloudflare EMAIL binding mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ messageId: 'sent-1' })));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// An operational store: the suspension guard (Ruling SUSPEND-OUT-1) reads it before the placeholder filter runs.
vi.mock('@api/lib/definer', () => ({
  lookupStore: async (m: { id?: string }) => ({ id: m.id, status: 'active' }),
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async () => ({
          id: 's1',
          name: 'S',
          slug: 'souq',
          domain: null,
          email: null,
          emailSenderLocalPart: null,
          emailDomainStatus: null,
        }),
      },
    }),
}));

import { isUndeliverableAddress, deliverableOnly } from '@api/lib/undeliverable-email';
import { StoreMailer } from '@api/services/store-mailer.service';
import { setCfBindings, clearCfBindings } from '@api/cf/bindings';

beforeEach(() => {
  send.mockClear();
});

describe('undeliverable addresses', () => {
  it('flags the RFC 2606 .invalid TLD and nothing else', () => {
    for (const a of ['wa-1@placeholder.invalid', 'a@X.INVALID'])
      expect(isUndeliverableAddress(a), a).toBe(true);
    for (const a of ['a@ebda.app', 'a@example.com', 'a@x.test', 'not-an-address'])
      expect(isUndeliverableAddress(a), a).toBe(false);
  });

  it('deliverableOnly keeps real recipients and drops placeholders', () => {
    expect(deliverableOnly(['a@ebda.app', 'wa-1@placeholder.invalid'])).toEqual(['a@ebda.app']);
    expect(deliverableOnly('wa-1@placeholder.invalid')).toEqual([]);
  });
});

describe('StoreMailer refuses *.invalid recipients', () => {
  beforeEach(() => {
    clearCfBindings();
    setCfBindings({ EMAIL: { send } });
  });

  it('sendBrandedEmail to a placeholder never reaches the provider', async () => {
    const r = await StoreMailer.sendBrandedEmail('s1', {
      to: 'wa-1@placeholder.invalid',
      subject: 's',
      html: '<p>order</p>',
    });
    expect(r.id).toBe('skipped-undeliverable');
    expect(send).not.toHaveBeenCalled();
  });

  it('a mixed list is sent to the real address only', async () => {
    await StoreMailer.sendBrandedEmail('s1', {
      to: ['a@ebda.app', 'wa-1@placeholder.invalid'],
      subject: 's',
      html: '<p>x</p>',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown as [{ to: string[] }])[0].to).toEqual(['a@ebda.app']);
  });

  it('batch and marketing sends drop placeholders too', async () => {
    const r = await StoreMailer.sendBrandedBatch('s1', {
      subject: 's',
      messages: [
        { to: 'wa-1@placeholder.invalid', html: 'x' },
        { to: 'a@ebda.app', html: 'x' },
      ],
    });
    // one message per address (Cloudflare has no batch endpoint); the placeholder is not counted as sent
    expect(send).toHaveBeenCalledTimes(1);
    expect(r.ids).toHaveLength(1);
    expect((send.mock.calls[0] as unknown as [{ to: string }])[0].to).toBe('a@ebda.app');
    const m = await StoreMailer.sendMarketingEmail({ id: 's1', name: 'S', slug: 'souq' } as never, {
      to: 'x@placeholder.invalid',
      subject: 's',
      html: 'x',
    });
    expect(m.id).toBe('skipped-undeliverable');
  });
});

describe('invalid addresses are never deliverable', () => {
  it('deliverableOnly drops empty, blank and domainless addresses', async () => {
    const { deliverableOnly } = await import('@api/lib/undeliverable-email');
    expect(deliverableOnly(['', ' ', 'a@', '@b.co', 'real@example.com'])).toEqual([
      'real@example.com',
    ]);
    expect(deliverableOnly('')).toEqual([]);
  });
});
