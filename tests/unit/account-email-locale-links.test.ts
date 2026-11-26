/**
 * Account emails (verify, reset, duplicate-registration notice, welcome, payment-failed) link to the STORE's own origin in the
 * language the mail is written in: `/en/auth/...` for an English shopper, `/ar/...` otherwise, never the platform WEB_URL
 * and never an unprefixed path (ebda-foundation standard/storefront-locale-routes.md). The copy language and the link prefix
 * come from the same value, so they cannot disagree.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@api/config', () => ({
  config: {
    jwtSecret: 'x',
    encryptionKey: 'test-encryption-key-0123456789abcdef',
    adminUrl: 'https://store.ebda.app',
    webUrl: 'https://store.ebda.app',
    apiUrl: 'https://api.ebda.app',
    nodeEnv: 'test',
  },
}));
const store = vi.hoisted(() => ({
  name: 'Amelia',
  slug: 'amelia',
  domain: 'ameliaaurum.com' as string | null,
  settings: { defaultLanguage: 'ar' },
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: async () => store } }),
}));

import { EmailService } from '../../apps/api/src/services/email.service';
import { storefrontAuthLink } from '../../apps/api/src/lib/storefront-auth-link';

const sent: Array<{ content: string; language: string }> = [];
beforeEach(() => {
  sent.length = 0;
  store.domain = 'ameliaaurum.com';
  vi.spyOn(
    EmailService as unknown as { sendForStore: () => Promise<void> },
    'sendForStore'
  ).mockImplementation((async (_id: string, m: { content: string; language: string }) => {
    sent.push(m);
  }) as never);
});

const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);

describe('storefrontAuthLink', () => {
  it('uses the custom domain, else the slug host; prefix = the mail language', () => {
    expect(storefrontAuthLink({ slug: 'a', domain: 'shop.example' }, 'en', '/auth/login')).toBe(
      'https://shop.example/en/auth/login'
    );
    expect(storefrontAuthLink({ slug: 'amelia' }, 'ar', '/auth/login')).toMatch(
      /^https:\/\/amelia\.[^/]+\/ar\/auth\/login$/
    );
  });
  it('STOREFRONT_LOCALE_PATHS=false (the rollback) drops the prefix; a non-path is refused', () => {
    expect(
      storefrontAuthLink({ slug: 'a', domain: 'shop.example' }, 'en', '/x', {
        STOREFRONT_LOCALE_PATHS: 'false',
      })
    ).toBe('https://shop.example/x');
    expect(() => storefrontAuthLink({ slug: 'a' }, 'en', '//evil.com')).toThrow();
  });
});

describe('account emails', () => {
  for (const lang of ['en', 'ar'] as const) {
    it(`verification link is ${lang}-prefixed on the store host and the copy is ${lang}`, async () => {
      await EmailService.sendEmailVerification(
        's1',
        {
          email: 'a@b.c',
          name: 'Sam',
          verificationPath: '/auth/verify-email?token=T',
          expiresInHours: 24,
        },
        lang
      );
      expect(sent[0].language).toBe(lang);
      expect(hrefs(sent[0].content).join(' ')).toContain(
        `https://ameliaaurum.com/${lang}/auth/verify-email?token=T`
      );
      expect(sent[0].content).not.toContain('store.ebda.app');
    });
    it(`reset link is ${lang}-prefixed on the store host`, async () => {
      await EmailService.sendPasswordReset(
        's1',
        {
          email: 'a@b.c',
          name: 'Sam',
          resetPath: '/auth/reset-password?token=T',
          expiresInMinutes: 30,
        },
        lang
      );
      expect(sent[0].language).toBe(lang);
      expect(sent[0].content).toContain(
        `https://ameliaaurum.com/${lang}/auth/reset-password?token=T`
      );
    });
    it(`duplicate-registration, welcome and payment-failed links are ${lang}-prefixed`, async () => {
      await EmailService.sendDuplicateRegistrationNotice(
        's1',
        { email: 'a@b.c', name: 'Sam' },
        lang
      );
      await EmailService.sendWelcome('s1', { email: 'a@b.c', name: 'Sam' }, lang);
      await EmailService.sendPaymentFailed(
        's1',
        { customerEmail: 'a@b.c', customerName: 'Sam', orderNumber: '1' },
        lang
      );
      for (const m of sent)
        for (const h of hrefs(m.content).filter(h => h.startsWith('https://ameliaaurum.com')))
          expect(h.startsWith(`https://ameliaaurum.com/${lang}`), h).toBe(true);
    });
  }
  it('without a language the store default decides both link and copy', async () => {
    await EmailService.sendPasswordReset('s1', {
      email: 'a@b.c',
      name: 'Sam',
      resetPath: '/auth/reset-password?token=T',
      expiresInMinutes: 30,
    });
    expect(sent[0].language).toBe('ar');
    expect(sent[0].content).toContain('https://ameliaaurum.com/ar/auth/reset-password?token=T');
  });
});

describe('no raw platform auth link is left in the API', () => {
  it('no `${config.webUrl}/auth/` in services', () => {
    const dir = path.join(__dirname, '../../apps/api/src/services');
    for (const f of ['auth.service.ts', 'customer-auth-flows.ts', 'email.service.ts']) {
      expect(readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(/webUrl\}?\/auth\//);
    }
  });
});
