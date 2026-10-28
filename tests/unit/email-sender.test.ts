import { describe, it, expect } from 'vitest';

import {
  resolveSender,
  merchantSenderLocalPart,
  merchantSenderPrefixInput,
  MERCHANT_SENDER_PREFIXES,
  type StoreSenderShape,
} from '@api/services/email-sender';
import { parseAddress } from '@api/services/mail-transport';

const baseStore = (overrides: Partial<StoreSenderShape> = {}): StoreSenderShape => ({
  name: 'Demo Shop',
  slug: 'demo-shop',
  domain: null,
  email: null,
  emailSenderLocalPart: null,
  emailDomainStatus: null,
  ...overrides,
});

describe('resolveSender (platform domain)', () => {
  it('default is orders.<slug>@ebda.app, never a bare platform mailbox', () => {
    const r = resolveSender(baseStore());
    expect(r.from).toBe('Demo Shop <orders.demo-shop@ebda.app>');
    expect(r.replyTo).toBeUndefined();
  });

  it.each(MERCHANT_SENDER_PREFIXES)('allows the approved prefix %s', p => {
    expect(resolveSender(baseStore({ emailSenderLocalPart: p })).from).toBe(
      `Demo Shop <${p}.demo-shop@ebda.app>`
    );
  });

  it.each([
    'noreply',
    'no-reply',
    'no.reply',
    'no_reply',
    'security',
    'Security',
    'security_team',
    'billing2',
    'ebda',
    'ebda-support',
    'ebda.support',
    'ahlan',
    'admin',
    'postmaster',
    'support.ebda',
    'ordérs',
    'orders ',
    'ord ers',
    '.orders',
    'orders..x',
    'support@evil',
  ])('rejects %j: falls back to orders', p => {
    const from = resolveSender(baseStore({ emailSenderLocalPart: p })).from;
    expect(from === 'Demo Shop <orders.demo-shop@ebda.app>' || p === 'orders ').toBe(true);
    expect(from).not.toMatch(/<(no-?reply|no\.reply|security|ahlan|admin|ebda)/i);
  });

  it('the slug suffix is mandatory for a merchant mailbox (the builder itself still throws)', () => {
    expect(() => merchantSenderLocalPart('orders', null)).toThrow(/slug/);
    expect(() => merchantSenderLocalPart('orders', '---')).toThrow(/slug/);
  });

  it('a feeder query that forgot to select slug falls back to the PLATFORM sender instead of crashing', () => {
    for (const slug of [null, undefined, '---']) {
      const r = resolveSender(baseStore({ slug: slug as never, name: 'Demo Shop' }));
      expect(r.from).toBe('Demo Shop via Ebda Store <no-reply@ebda.app>');
      // never a bare brand and never an invented merchant mailbox
      expect(r.from).not.toMatch(/<orders\./);
    }
  });

  it('a slug is reduced to [a-z0-9-] so it cannot add a mailbox or a domain', () => {
    expect(merchantSenderLocalPart('hello', 'Evil.Shop@x')).toBe('hello.evilshopx');
  });

  it('every generated address is <approved prefix>.<slug>@ebda.app (property)', () => {
    const slugs = ['a', 'shop-1', 'x'.repeat(80), 'ebda', 'no-reply', 'security'];
    for (const slug of slugs) {
      for (const chosen of [null, '', 'noreply', 'orders', 'support', 'security', 'zz']) {
        const lp = merchantSenderLocalPart(chosen, slug);
        expect(lp).toMatch(/^(orders|receipts|hello|info|support)\.[a-z0-9-]{1,48}$/);
        expect(lp.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it('sets replyTo to the store contact email when present', () => {
    expect(resolveSender(baseStore({ email: 'hi@demo-shop.example' })).replyTo).toBe(
      'hi@demo-shop.example'
    );
  });

  it('ignores a merchant domain: mail always leaves from ebda.app (not our zone)', () => {
    const r = resolveSender(
      baseStore({ domain: 'demo-shop.example', emailDomainStatus: 'verified' })
    );
    expect(r.from).toBe('Demo Shop <orders.demo-shop@ebda.app>');
  });

  it('strips CRLF, control chars and From-breaking characters from the store name', () => {
    expect(resolveSender(baseStore({ name: 'Demo Shop\r\nBcc: a@b.c' })).from).toBe(
      'Demo Shop Bcc: a@b.c <orders.demo-shop@ebda.app>'
    );
    expect(resolveSender(baseStore({ name: 'Demo\x00Shop\x07' })).from).toBe(
      'Demo Shop <orders.demo-shop@ebda.app>'
    );
    const r = resolveSender(baseStore({ name: 'Ahmad "Best" <Shop>\\' }));
    expect(parseAddress(r.from)).toEqual({
      email: 'orders.demo-shop@ebda.app',
      name: 'Ahmad Best Shop',
    });
  });
});

describe('save-time schema (store.routes uses merchantSenderPrefixInput)', () => {
  it.each(MERCHANT_SENDER_PREFIXES)('accepts %s', p => {
    expect(merchantSenderPrefixInput.safeParse(p).success).toBe(true);
  });
  it.each(['', null, undefined, 'noreply', 'no-reply'])('treats %j as unset', v => {
    const r = merchantSenderPrefixInput.safeParse(v);
    expect(r.success && r.data === undefined).toBe(true);
  });
  it.each([
    'no.reply',
    'no_reply',
    'ebda-support',
    'security_team',
    'billing2',
    'security',
    'ahlan',
    'admin',
    'orders.evil',
    'ORDERS',
    'orders ',
    'support@x',
    'a'.repeat(65),
  ])('rejects %j', v => {
    expect(merchantSenderPrefixInput.safeParse(v).success).toBe(false);
  });
});
