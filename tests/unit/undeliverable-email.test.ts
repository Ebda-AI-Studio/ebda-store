/**
 * Ruling WA-LEGACY-1: the email layer refuses to send to a reserved-TLD address (a placeholder can
 * never deliver). Covers the helper and the real ResendService send path with the SDK mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.hoisted(() => vi.fn(async () => ({ data: { id: 'sent-1' }, error: null })));
const batch = vi.hoisted(() =>
  vi.fn(async () => ({ data: { data: [{ id: 'b1' }] }, error: null }))
);
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
    batch = { send: batch };
  },
}));
vi.mock('@api/config', () => ({ config: { resendApiKey: 're_test' } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
import { ResendService } from '@api/services/resend.service';

beforeEach(() => {
  send.mockClear();
  batch.mockClear();
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

describe('ResendService refuses *.invalid recipients', () => {
  it('sendBrandedEmail to a placeholder never reaches Resend', async () => {
    const r = await ResendService.sendBrandedEmail('s1', {
      to: 'wa-1@placeholder.invalid',
      subject: 's',
      html: '<p>order</p>',
    });
    expect(r.id).toBe('skipped-undeliverable');
    expect(send).not.toHaveBeenCalled();
  });

  it('a mixed list is sent to the real address only', async () => {
    await ResendService.sendBrandedEmail('s1', {
      to: ['a@ebda.app', 'wa-1@placeholder.invalid'],
      subject: 's',
      html: '<p>x</p>',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown as [{ to: string[] }])[0].to).toEqual(['a@ebda.app']);
  });

  it('batch and marketing sends drop placeholders too', async () => {
    await ResendService.sendBrandedBatch('s1', {
      subject: 's',
      messages: [
        { to: 'wa-1@placeholder.invalid', html: 'x' },
        { to: 'a@ebda.app', html: 'x' },
      ],
    });
    // one message per address now (Cloudflare has no batch endpoint): only the deliverable one goes out
    expect(send).toHaveBeenCalledTimes(1);
    const sent = (send.mock.calls[0] as unknown as [{ to: string[] }])[0];
    expect(sent.to).toEqual(['a@ebda.app']);
    const m = await ResendService.sendMarketingEmail({ id: 's1', name: 'S' } as never, {
      to: 'x@placeholder.invalid',
      subject: 's',
      html: 'x',
    });
    expect(m.id).toBe('skipped-undeliverable');
  });
});
