/**
 * Email campaigns (D2) — the audience builder is the consent gate.
 *
 * The fake Prisma EVALUATES the `where` it is given, so deleting any predicate
 * from `buildCampaignAudience` returns rows the test forbids. Mutation-proven:
 * see docs/plans/done/2026-09-25-email-campaigns.md (Verification).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createFakePrisma,
  subscriberRow,
  STORE_A,
  STORE_B,
  type FakeDb,
} from '../helpers/campaign-fake-db';

const { holder } = vi.hoisted(() => ({ holder: { prisma: null as any } }));

vi.mock('@ebda/database', () => ({
  get prisma() {
    return holder.prisma;
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  audienceCount,
  buildCampaignAudience,
  pickCampaignContent,
  resolveRecipientLocale,
  listUnsubscribeHeaders,
  renderCampaignEmail,
  sanitizeSubject,
} from '@api/services/campaign.service';

let db: FakeDb;
beforeEach(() => {
  db = { stores: [], campaigns: [], recipients: [], subscribers: [], customers: [] };
  holder.prisma = createFakePrisma(db);
});

describe('buildCampaignAudience — consent only', () => {
  it('includes only ACTIVE subscribers of this store', async () => {
    db.subscribers.push(
      subscriberRow(STORE_A, 'yes@a.test'),
      subscriberRow(STORE_A, 'inactive@a.test', { isActive: false }),
      subscriberRow(STORE_A, 'unsub@a.test', { unsubscribedAt: new Date() })
    );
    const audience = await buildCampaignAudience(STORE_A);
    expect(audience.map(a => a.email)).toEqual(['yes@a.test']);
  });

  it('excludes cart-reminder-only consent: "email me about my cart" is not a newsletter opt-in', async () => {
    db.subscribers.push(
      subscriberRow(STORE_A, 'news@a.test'),
      subscriberRow(STORE_A, 'cart@a.test', { consentScope: 'cart_reminders', source: 'checkout' })
    );
    expect((await buildCampaignAudience(STORE_A)).map(a => a.email)).toEqual(['news@a.test']);
    expect(await audienceCount(STORE_A)).toBe(1);
  });

  it('excludes a row that is flagged active but carries an unsubscribedAt', async () => {
    db.subscribers.push(
      subscriberRow(STORE_A, 'half@a.test', { isActive: true, unsubscribedAt: new Date() })
    );
    expect(await buildCampaignAudience(STORE_A)).toEqual([]);
  });

  it('is tenant-scoped: another store’s subscribers never appear', async () => {
    db.subscribers.push(
      subscriberRow(STORE_A, 'mine@a.test'),
      subscriberRow(STORE_B, 'theirs@b.test')
    );
    const audience = await buildCampaignAudience(STORE_A);
    expect(audience.map(a => a.email)).toEqual(['mine@a.test']);
  });

  it('dedupes by lowercased, trimmed email and keeps the first row', async () => {
    const first = subscriberRow(STORE_A, 'Dup@A.test');
    db.subscribers.push(first, subscriberRow(STORE_A, ' dup@a.test '));
    const audience = await buildCampaignAudience(STORE_A);
    expect(audience).toEqual([{ email: 'dup@a.test', subscriberId: first.id, language: null }]);
  });

  it('skips a malformed address and maps the signup language', async () => {
    db.subscribers.push(
      subscriberRow(STORE_A, 'not-an-email'),
      subscriberRow(STORE_A, 'ar@a.test', { language: 'ar' }),
      subscriberRow(STORE_A, 'fr@a.test', { language: 'fr' })
    );
    const audience = await buildCampaignAudience(STORE_A);
    expect(audience.map(a => [a.email, a.language])).toEqual([
      ['ar@a.test', 'ar'],
      ['fr@a.test', null],
    ]);
  });

  it('never reads customers — buying once is not consent', async () => {
    db.customers.push({ id: 'c1', storeId: STORE_A, email: 'buyer@a.test' });
    const spy = vi.spyOn(holder.prisma.customer, 'findMany');
    expect(await buildCampaignAudience(STORE_A)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('audienceCount — #1953, mirrors buildCampaignAudience without materializing every row', () => {
  it('matches buildCampaignAudience.length for every scenario the audience builder covers', async () => {
    db.subscribers.push(
      subscriberRow(STORE_A, 'yes@a.test'),
      subscriberRow(STORE_A, 'inactive@a.test', { isActive: false }),
      subscriberRow(STORE_A, 'unsub@a.test', { unsubscribedAt: new Date() }),
      subscriberRow(STORE_A, 'half@a.test', { isActive: true, unsubscribedAt: new Date() }),
      subscriberRow(STORE_A, 'Dup@A.test'),
      subscriberRow(STORE_A, ' dup@a.test '),
      subscriberRow(STORE_A, 'not-an-email'),
      subscriberRow(STORE_B, 'theirs@b.test')
    );

    const [audience, count] = await Promise.all([
      buildCampaignAudience(STORE_A),
      audienceCount(STORE_A),
    ]);

    expect(count).toBe(audience.length);
    expect(count).toBe(2); // yes@a.test, dup@a.test (deduped)
  });

  it('is tenant-scoped, same as buildCampaignAudience', async () => {
    db.subscribers.push(
      subscriberRow(STORE_A, 'mine@a.test'),
      subscriberRow(STORE_B, 'theirs@b.test')
    );
    expect(await audienceCount(STORE_A)).toBe(1);
    expect(await audienceCount(STORE_B)).toBe(1);
  });

  it('is 0 for a store with no reachable subscribers', async () => {
    expect(await audienceCount(STORE_A)).toBe(0);
  });
});

describe('content + locale', () => {
  const content = {
    subject: 'Hi',
    subjectAr: 'أهلاً',
    bodyHtml: '<p>EN</p>',
    bodyHtmlAr: '<p>AR</p>',
  };

  it('resolves locale from the strategy, then the subscriber, then the store default', () => {
    expect(resolveRecipientLocale('ar', 'en', 'en')).toBe('ar');
    expect(resolveRecipientLocale('subscriber', 'ar', 'en')).toBe('ar');
    expect(resolveRecipientLocale('subscriber', null, 'ar')).toBe('ar');
  });

  it('falls back to the other language when the chosen one is incomplete', () => {
    expect(pickCampaignContent({ ...content, bodyHtmlAr: null }, 'ar')).toEqual({
      locale: 'en',
      subject: 'Hi',
      bodyHtml: '<p>EN</p>',
    });
    expect(pickCampaignContent(content, 'ar').locale).toBe('ar');
  });

  it('strips CR/LF from subjects so no header can be injected', () => {
    expect(sanitizeSubject('Sale\r\nBcc: x@evil.test')).toBe('Sale Bcc: x@evil.test');
  });

  it('only advertises List-Unsubscribe for an https API origin', () => {
    expect(listUnsubscribeHeaders('http://localhost:4000', 't')).toBeUndefined();
    expect(listUnsubscribeHeaders('https://api.ebda.app/', 'a.b.c')).toEqual({
      'List-Unsubscribe': '<https://api.ebda.app/api/v1/public/campaigns/unsubscribe?token=a.b.c>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('renders a sanitized body plus a working unsubscribe link', () => {
    const { html } = renderCampaignEmail({
      store: {
        id: STORE_A,
        name: 'Shop <b>',
        nameAr: null,
        logo: null,
        email: null,
        phone: null,
        address: null,
        theme: null,
        settings: null,
        slug: 's',
        domain: null,
        emailSenderLocalPart: null,
        emailDomainStatus: null,
      },
      locale: 'en',
      subject: 'x',
      bodyHtml: '<p onclick="x()">Hi</p><script>alert(1)</script>',
      unsubscribeUrl: 'https://shop.test/unsubscribe?token=abc',
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).toContain('href="https://shop.test/unsubscribe?token=abc"');
    expect(html).toContain('Shop &lt;b&gt;');
  });
});
