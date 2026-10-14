import { BRAND, BRAND_EMAIL_LOGO_URL } from '@ebda/shared';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// email.service now imports @ebda/database at the module level;
// mock it so this unit test doesn't require a generated prisma client.
const { prismaStoreFindUnique } = vi.hoisted(() => ({
  prismaStoreFindUnique: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: Record<string, any> = {
    prisma: { store: { findUnique: prismaStoreFindUnique } },
  };
  mod.withStore = (_id: string, fn: (tx: unknown) => unknown) => fn(mod.prisma);
  return mod;
});

// ResendService is called by sendForStore — mock it out so no real HTTP.
vi.mock('@api/services/resend.service', () => ({
  ResendService: {
    sendBrandedEmail: vi.fn().mockResolvedValue({ id: 'em_test' }),
  },
}));

vi.mock('@api/config', () => ({
  config: {
    resendApiKey: 're_test',
    webUrl: 'https://store.test',
    adminUrl: 'https://admin.test',
    smtpFromEmail: 'noreply@test.com',
  },
}));

import {
  renderBrandedShell,
  type EmailStoreContext,
  EmailService,
} from '@api/services/email.service';

const baseStore = (overrides: Partial<EmailStoreContext> = {}): EmailStoreContext => ({
  name: 'Demo Shop',
  logo: null,
  theme: null,
  email: null,
  phone: null,
  address: null,
  defaultLanguage: 'en',
  ...overrides,
});

describe('renderBrandedShell', () => {
  it.each(['en', 'ar'] as const)(
    'platform mail shows its full product name and localized attribution (%s)',
    language => {
      const html = renderBrandedShell(
        '<p>message</p>',
        baseStore({
          name: BRAND.product.nameEn,
          nameAr: BRAND.product.nameAr,
          logo: BRAND_EMAIL_LOGO_URL,
          defaultLanguage: language,
        })
      );
      const name = language === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn;
      expect(html).toMatch(new RegExp(`<div class="store-name"[^>]*>${name}</div>`));
      expect(html).toContain(language === 'ar' ? `مدعوم من ${name}` : `Powered by ${name}`);
    }
  );

  it('uses store name in header when no logo', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore());
    expect(html).toMatch(/<div class="store-name"[^>]*>Demo Shop<\/div>/);
    expect(html).toContain('© ' + new Date().getFullYear() + ' Demo Shop');
  });

  it('renders logo img when logo url present (no store-name fallback)', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ logo: 'https://r2.dev/logo.png' }));
    expect(html).toContain('<img src="https://r2.dev/logo.png"');
    expect(html).not.toMatch(/<div class="store-name"[^>]*>Demo Shop<\/div>/);
  });

  it('uses store theme primary color when set as hex (canonical primaryColor key)', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ theme: { primaryColor: '#2D1418' } }));
    // Inline, solid hex: Gmail drops CSS custom properties with the <style> block.
    expect(html).toContain('background-color:#2D1418');
  });

  it('uses HSL components when theme primaryColor is the Tailwind-token format', () => {
    const html = renderBrandedShell(
      '<p>hi</p>',
      baseStore({ theme: { primaryColor: '348 68% 25%' } })
    );
    // HSL components are converted to hex (email clients mis-parse
    // space-separated hsl()); the soft header tint is a solid hex mix.
    expect(html).toContain('background-color:#6b1426');
    expect(html).toContain('bgcolor="#f6f1f2"');
    expect(html).not.toMatch(/hsla?\(/);
  });

  it('falls back to platform gold when theme color is invalid', () => {
    const html = renderBrandedShell(
      '<p>hi</p>',
      baseStore({ theme: { primaryColor: 'rm -rf /' } })
    );
    expect(html).toContain('background-color:#B08D57');
    expect(html).not.toContain('rm -rf');
  });

  it('accepts legacy `primary` key for backward compat', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ theme: { primary: '#2D1418' } }));
    expect(html).toContain('background-color:#2D1418');
  });

  it('renders RTL when defaultLanguage is ar', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ defaultLanguage: 'ar' }));
    expect(html).toContain('dir="rtl"');
  });

  it('sets the content direction explicitly (rtl + physical right alignment for Arabic)', () => {
    // dir="auto" took direction from the first strong character, so an Arabic
    // email opening with a Latin store name or order number rendered LTR.
    const html = renderBrandedShell('<p>hi</p>', baseStore({ defaultLanguage: 'ar' }));
    expect(html).toContain('class="content" dir="rtl" align="right"');
  });

  it('includes powered-by line in footer', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore());
    expect(html).toContain('Powered by Ebda');
  });

  it('escapes the store name to prevent XSS in header', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ name: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// Language override scaffold (Task 1)
// ---------------------------------------------------------------------------

/**
 * Build a minimal store row as returned by prisma.store.findUnique inside
 * sendForStore. The `settings` column is stored as JSON — we use a plain
 * object here and cast it via the service's own
 * `(store.settings as Record<string,unknown>)` path.
 */
function makeStorePrismaRow(
  overrides: {
    defaultLanguage?: 'en' | 'ar';
    name?: string;
  } = {}
) {
  return {
    id: 'store-test',
    name: overrides.name ?? 'Test Store',
    nameAr: null,
    logo: null,
    theme: null,
    email: null,
    phone: null,
    address: null,
    domain: null,
    emailSenderLocalPart: 'noreply',
    emailDomainStatus: null,
    settings: overrides.defaultLanguage ? { defaultLanguage: overrides.defaultLanguage } : {},
  };
}

describe('EmailService language override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('explicit language:"ar" produces an RTL shell (dir="rtl")', async () => {
    prismaStoreFindUnique.mockResolvedValue(makeStorePrismaRow({ defaultLanguage: 'en' }));

    // Use the internal test helper that exercises renderTemplate → renderBrandedShell
    // via sendOrderConfirmation path, but capture at the ResendService boundary
    // by inspecting the html arg that sendBrandedEmail receives.
    const { ResendService } = await import('@api/services/resend.service');
    const sendBrandedEmailMock = vi.mocked(ResendService.sendBrandedEmail);

    await EmailService.sendOrderConfirmation(
      'store-test',
      {
        orderNumber: 'ORD-1',
        customerName: 'Ahmad',
        customerEmail: 'a@example.com',
        items: [{ name: 'Widget', quantity: 1, price: 1000 }],
        subtotal: 1000,
        tax: 0,
        shipping: 0,
        total: 1000,
        shippingAddress: {
          firstName: 'Ahmad',
          lastName: 'S',
          address1: '1 Main St',
          city: 'Cairo',
          state: 'EG',
          postalCode: '12345',
          country: 'EG',
        },
      },
      'ar'
    );

    expect(sendBrandedEmailMock).toHaveBeenCalledOnce();
    const sentHtml: string = sendBrandedEmailMock.mock.calls[0][1].html;
    expect(sentHtml).toContain('dir="rtl"');
  });

  it('omitting language falls back to store.settings.defaultLanguage="ar" → RTL', async () => {
    // Store configured as Arabic — no explicit language arg
    prismaStoreFindUnique.mockResolvedValue(makeStorePrismaRow({ defaultLanguage: 'ar' }));

    const { ResendService } = await import('@api/services/resend.service');
    const sendBrandedEmailMock = vi.mocked(ResendService.sendBrandedEmail);

    await EmailService.sendOrderConfirmation('store-test', {
      orderNumber: 'ORD-2',
      customerName: 'Fatima',
      customerEmail: 'f@example.com',
      items: [{ name: 'Widget', quantity: 1, price: 2000 }],
      subtotal: 2000,
      tax: 0,
      shipping: 0,
      total: 2000,
      shippingAddress: {
        firstName: 'Fatima',
        lastName: 'K',
        address1: '2 Main St',
        city: 'Cairo',
        state: 'EG',
        postalCode: '12345',
        country: 'EG',
      },
    });
    // No language arg — should read store.settings.defaultLanguage = 'ar'

    expect(sendBrandedEmailMock).toHaveBeenCalledOnce();
    const sentHtml: string = sendBrandedEmailMock.mock.calls[0][1].html;
    expect(sentHtml).toContain('dir="rtl"');
  });

  it('explicit language:"en" overrides an Arabic store default → LTR', async () => {
    // Store is Arabic but caller explicitly requests English
    prismaStoreFindUnique.mockResolvedValue(makeStorePrismaRow({ defaultLanguage: 'ar' }));

    const { ResendService } = await import('@api/services/resend.service');
    const sendBrandedEmailMock = vi.mocked(ResendService.sendBrandedEmail);

    await EmailService.sendOrderConfirmation(
      'store-test',
      {
        orderNumber: 'ORD-3',
        customerName: 'John',
        customerEmail: 'j@example.com',
        items: [{ name: 'Widget', quantity: 1, price: 3000 }],
        subtotal: 3000,
        tax: 0,
        shipping: 0,
        total: 3000,
        shippingAddress: {
          firstName: 'John',
          lastName: 'D',
          address1: '3 Main St',
          city: 'Cairo',
          state: 'EG',
          postalCode: '12345',
          country: 'EG',
        },
      },
      'en'
    );

    expect(sendBrandedEmailMock).toHaveBeenCalledOnce();
    const sentHtml: string = sendBrandedEmailMock.mock.calls[0][1].html;
    expect(sentHtml).toContain('dir="ltr"');
    expect(sentHtml).not.toContain('dir="rtl"');
  });
});
