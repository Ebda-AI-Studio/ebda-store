/**
 * Every transactional email must stay readable in a client that strips
 * `<style>` (Gmail app, Outlook): sizing lives in HTML attributes + inline
 * styles, never in a class a `<style>` block would have sized.
 *
 * Regression: Demo Store's invoice email (ORD-TM67JC-2Q6XK, 2026-09-30) on the
 * Gmail Android app rendered the logo at 1600px (twice), the product photo at
 * 1200×1600 and the print page's "PAID" watermark as a loose block — the
 * emailed invoice was the printable web page, class-sized, nested in the shell.
 *
 * Mutation proof (each was broken, the named test went red, then restored):
 *  - `emailImage` without `max-width:100%`          → "every <img> is sized inline"
 *  - shell `width="${EMAIL_MAX_WIDTH}"` → 640        → "600px container"
 *  - invoice-email Inngest fn back to generateInvoice → "invoice email is not the print page"
 *  - shell re-adds a `<style>` block                  → "no <style> block"
 *  - shell content cell `dir="auto"`                  → "Arabic wraps rtl"
 *  - invoice thumbnail `width: 1200`, no height       → invoice "every <img>" + "600px container"
 *  - inliner stops resolving `var(--brand)`           → reviewRequest "no <style> block, no CSS…"
 *  - logo gets `object-fit:cover`                     → "logo scales down whole" (5 red)
 *  - logo gets a fixed `height:56px`                  → "logo scales down whole" + "every <img>" (36 red)
 *  - header cell `height="72"` + `overflow:hidden`   → "logo scales down whole" (5 red)
 *  - logo loses `maxHeight` (issue 2336)              → "every <img>" + "logo scales down whole"
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const findFirst = vi.fn();
vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn((await import('./helpers/invoice-repo-mock')).platformTx()),
  prisma: {
    fiscalDocument: { findMany: async () => [] }, // legacy order: no fiscal document (MONEYB-1)
    order: { findFirst: (...a: unknown[]) => findFirst(...a) },
    store: { findUnique: vi.fn() },
  },
}));
vi.mock('@api/lib/repo-factory', async () =>
  (await import('./helpers/invoice-repo-mock')).repoFactoryMock()
);
vi.mock('@api/lib/jobs/store-db', async () =>
  (await import('./helpers/invoice-repo-mock')).storeDbMock()
);
vi.mock('@api/services/store-mailer.service', () => ({
  StoreMailer: { sendBrandedEmail: vi.fn() },
}));
vi.mock('@api/config', () => ({
  config: { webUrl: 'https://store.test', adminUrl: 'https://admin.test' },
}));

import { renderBrandedShell, type EmailStoreContext } from '@api/services/email.service';
import { InvoiceService, renderInvoiceEmailContent } from '@api/services/invoice.service';
import { renderCampaignEmail } from '@api/services/campaign.service';
import { EMAIL_MAX_WIDTH } from '@api/services/email-templates/_layout';
import { welcomeTemplate } from '@api/services/email-templates/welcome';
import { passwordResetTemplate } from '@api/services/email-templates/password-reset';
import { emailVerificationTemplate } from '@api/services/email-templates/email-verification';
import { resendVerificationTemplate } from '@api/services/email-templates/resend-verification';
import { duplicateRegistrationTemplate } from '@api/services/email-templates/duplicate-registration';
import { orderConfirmationTemplate } from '@api/services/email-templates/order-confirmation';
import { orderRefundedTemplate } from '@api/services/email-templates/order-refunded';
import { orderCancelledNotChargedTemplate } from '@api/services/email-templates/order-cancelled-not-charged';
import { orderShippedTemplate } from '@api/services/email-templates/order-shipped';
import { paymentSuccessTemplate } from '@api/services/email-templates/payment-success';
import { paymentFailedTemplate } from '@api/services/email-templates/payment-failed';
import { returnConfirmationTemplate } from '@api/services/email-templates/return-confirmation';
import { returnStatusUpdateTemplate } from '@api/services/email-templates/return-status-update';
import { reviewRequestTemplate } from '@api/services/email-templates/review-request';
import { lowStockAlertTemplate } from '@api/services/email-templates/low-stock-alert';
import { GOLD_RATE_NOTICES } from '@api/services/email-templates/gold-rate-notices';
import { planLimitReachedTemplate } from '@api/services/email-templates/plan-limit-reached';
import { lifecycleContent } from '@api/services/email-templates/lifecycle';
import { contactEnquiryReceipt } from '@api/services/email-templates/contact-enquiry';
import { webhookDisabledTemplate } from '@api/services/email-templates/webhook-disabled';
import { subscriptionBillingTemplate } from '@api/services/email-templates/subscription-billing';
import { staffInviteTemplate } from '@api/services/email-templates/staff-invite';
import { factorEnrolCodeTemplate } from '@api/services/email-templates/factor-enrol-code';
import { factorAddedNoticeTemplate } from '@api/services/email-templates/factor-added-notice';
import { legalNoticeTemplate } from '@api/services/email-templates/legal-notice';
import { passkeyNoticeTemplate } from '@api/services/email-templates/passkey-notice';
import { wholesaleNotice } from '@api/services/email-templates/wholesale';
import { cartRecoveryTemplate } from '@api/services/email-templates/cart-recovery';

type Locale = 'en' | 'ar';

const STORE = (locale: Locale): EmailStoreContext => ({
  name: 'Demo Store',
  logo: 'https://pub.r2.dev/logo-1600x420.png',
  theme: { primaryColor: '28 55% 30%' },
  email: 'hello@demo-store.test',
  phone: '+965 5555 1234',
  address: 'Cairo',
  defaultLanguage: locale,
});

const addr = {
  firstName: 'Sara',
  lastName: 'Ali',
  address1: 'Block 3',
  city: 'Salmiya',
  state: 'Hawalli',
  postalCode: '22000',
  country: 'Egypt',
};
const orderData = {
  orderNumber: 'ORD-1',
  customerName: 'Sara',
  customerEmail: 's@x.test',
  items: [{ name: 'Pecan Box', nameAr: 'علبة', quantity: 1, price: 8500 }],
  subtotal: 8500,
  tax: 0,
  shipping: 1000,
  total: 9500,
  shippingAddress: addr,
};
// Superset fixture: each template reads the fields it needs.
const any = {
  ...orderData,
  email: 's@x.test',
  name: 'Sara',
  resetUrl: 'https://s.test/r',
  kind: 'added',
  passkeyName: 'Work laptop',
  at: '2026-10-21T10:00:00.000Z',
  verificationUrl: 'https://s.test/v',
  expiresInMinutes: 15,
  expiresInHours: 24,
  reason: 'Declined',
  trackingNumber: 'TRK1',
  trackingUrl: 'https://t.test',
  carrier: 'Aramex',
  storeName: 'Demo Store',
  returnNumber: 'RET-1',
  type: 'refund',
  status: 'approved',
  orderTotal: 9500,
  refundAmount: 9500,
  to: 's@x.test',
  items: [
    {
      ...orderData.items[0],
      productName: 'Pecan Box',
      productImage: 'https://pub.r2.dev/product-1200x1600.jpg',
      reviewLink: 'https://s.test/review',
      productId: 'p1',
      inventory: 1,
      lowStockThreshold: 5,
    },
  ],
  adminUrl: 'https://admin.test',
  planName: 'Free',
  limit: 100,
  used: 120,
  billingUrl: 'https://admin.test/stores/s1/billing',
  amountMinor: 49900,
  retryOn: '2026-11-06',
  loginUrl: 'https://admin.test/login',
  setPasswordUrl: 'https://admin.test/reset-password?token=abc',
};

const LEGAL_NOTICE_SAMPLE = {
  name: 'Sara',
  title: { ar: 'شروط الخدمة', en: 'Terms of service' },
  summary: { ar: 'عدّلنا الرسوم.', en: 'We changed the fees.' },
  effectiveOn: { ar: '20 نوفمبر 2026', en: '20 November 2026' },
  url: { ar: 'https://ebda.app/terms/', en: 'https://ebda.app/en/terms/' },
};

const WS_SAMPLE = {
  customerName: 'Sara',
  storeName: 'Demo Store',
  businessName: 'Sara Trading',
  note: 'Not now',
};
const CART_RECOVERY_SAMPLE = {
  storeName: 'Demo Store',
  items: [{ productName: 'Linen shirt', price: 25000, quantity: 2 }],
  total: 50000,
  cartUrl: 'https://s.test/cart',
  unsubscribeUrl: 'https://s.test/unsubscribe?token=t',
};

const LIFECYCLE_SAMPLE = {
  kind: 'trial_recap' as const,
  storeName: 'Demo Store',
  links: {
    products: 'https://s.test/p',
    payment: 'https://s.test/pay',
    storefront: 'https://s.test',
    billing: 'https://s.test/billing',
  },
  unsubscribeUrl: 'https://s.test/unsubscribe?token=t',
  recoveredCarts: 2,
  daysLeft: 4,
};

type Tpl = Record<Locale, (...a: never[]) => string>;
const TEMPLATES: Record<string, Tpl> = {
  welcome: welcomeTemplate,
  passwordReset: passwordResetTemplate,
  emailVerification: emailVerificationTemplate,
  resendVerification: resendVerificationTemplate,
  duplicateRegistration: duplicateRegistrationTemplate,
  orderConfirmation: orderConfirmationTemplate,
  orderRefunded: orderRefundedTemplate,
  orderCancelledNotCharged: orderCancelledNotChargedTemplate,
  orderShipped: orderShippedTemplate,
  paymentSuccess: paymentSuccessTemplate,
  paymentFailed: paymentFailedTemplate,
  returnConfirmation: returnConfirmationTemplate,
  returnStatusUpdate: returnStatusUpdateTemplate,
  reviewRequest: reviewRequestTemplate,
  lowStockAlert: lowStockAlertTemplate,
  // Gold-rate notices (Phase B5): the warning, the selling-paused and the pending-rate notice share one file.
  goldRateNotices: {
    en: () =>
      (['warning', 'blocked', 'pending'] as const)
        .map(k =>
          GOLD_RATE_NOTICES[k].en({
            storeName: 'Demo Store',
            adminUrl: 'https://admin.test',
            hours: 22,
            maxHours: 26,
            karat: 21,
            rateText: '6,238 EGP',
            jumpText: '7.0%',
          })
        )
        .join(''),
    ar: () =>
      (['warning', 'blocked', 'pending'] as const)
        .map(k =>
          GOLD_RATE_NOTICES[k].ar({
            storeName: 'Demo Store',
            adminUrl: 'https://admin.test',
            hours: 22,
            maxHours: 26,
            karat: 21,
            rateText: '6,238 EGP',
            jumpText: '7.0%',
          })
        )
        .join(''),
  },
  planLimitReached: planLimitReachedTemplate,
  webhookDisabled: webhookDisabledTemplate,
  subscriptionBilling: subscriptionBillingTemplate,
  staffInvite: staffInviteTemplate,
  factorEnrolCode: factorEnrolCodeTemplate,
  factorAddedNotice: factorAddedNoticeTemplate,
  passkeyNotice: passkeyNoticeTemplate,
  // Recovery email takes a data object, not the (data, storeName, url) triple.
  cartRecovery: {
    en: () => cartRecoveryTemplate.en(CART_RECOVERY_SAMPLE),
    ar: () => cartRecoveryTemplate.ar(CART_RECOVERY_SAMPLE),
  },
  // Lifecycle emails take a data object; trial_recap is the richest kind (stat + days + CTA + unsubscribe).
  lifecycle: {
    en: () => lifecycleContent(LIFECYCLE_SAMPLE, 'en'),
    ar: () => lifecycleContent(LIFECYCLE_SAMPLE, 'ar'),
  },
  // One bilingual body for every recipient (Ruling LEGAL-6), so both locale keys render the same.
  // One entry covers wholesale.ts (received / approved / rejected share a single layout).
  wholesaleNotice: {
    en: () => wholesaleNotice('rejected', 'en', WS_SAMPLE).content,
    ar: () => wholesaleNotice('rejected', 'ar', WS_SAMPLE).content,
  },
  // The visitor's receipt (the studio-inbox mail in the same file is internal and English-only).
  contactEnquiry: {
    en: () => contactEnquiryReceipt.en({ name: 'Mona', requestId: 'r1' }),
    ar: () => contactEnquiryReceipt.ar({ name: 'منى', requestId: 'r1' }),
  },
  legalNotice: {
    en: () => legalNoticeTemplate.body(LEGAL_NOTICE_SAMPLE),
    ar: () => legalNoticeTemplate.body(LEGAL_NOTICE_SAMPLE),
  },
};

function invoiceOrder(locale: Locale) {
  return {
    id: 'o1',
    orderNumber: 'ORD-TM67JC-2Q6XK',
    locale,
    currency: 'EGP',
    status: 'processing',
    paymentStatus: 'paid',
    createdAt: new Date('2026-09-29T10:00:00Z'),
    subtotal: 8500,
    discount: 0,
    couponCode: null,
    couponDiscount: 0,
    promotionDiscount: 0,
    loyaltyDiscount: 0,
    loyaltyPointsRedeemed: null,
    tax: 0,
    taxIncludedInPrice: false,
    shipping: 1000,
    total: 9500,
    notes: null,
    shippingAddress: addr,
    billingAddress: null,
    store: { ...STORE(locale), currency: 'EGP', timezone: 'Africa/Cairo' },
    customer: null,
    items: [
      {
        id: 'i1',
        productName: 'Pecan Box',
        variantName: null,
        sku: 'PB',
        quantity: 1,
        price: 8500,
        total: 8500,
        bundleId: null,
        product: { nameAr: 'علبة', images: [{ url: 'https://pub.r2.dev/product-1200x1600.jpg' }] },
      },
    ],
    payments: [],
    appliedPromotion: null,
  };
}

/** Every rendered email, as it is handed to Resend. */
function renderAll(): Array<{ name: string; locale: Locale; html: string }> {
  const out: Array<{ name: string; locale: Locale; html: string }> = [];
  for (const locale of ['en', 'ar'] as const) {
    for (const [name, tpl] of Object.entries(TEMPLATES)) {
      const content = (tpl[locale] as (...a: unknown[]) => string)(
        any,
        'Demo Store',
        'https://s.test'
      );
      out.push({ name, locale, html: renderBrandedShell(content, STORE(locale)) });
    }
    const invoice = renderInvoiceEmailContent(
      invoiceOrder(locale) as unknown as Parameters<typeof renderInvoiceEmailContent>[0],
      locale
    );
    out.push({ name: 'invoice', locale, html: renderBrandedShell(invoice, STORE(locale)) });
    out.push({
      name: 'campaign',
      locale,
      html: renderCampaignEmail({
        store: { ...STORE(locale), nameAr: null } as never,
        locale,
        subject: 'Hi',
        bodyHtml: '<h2>Sale</h2><p>20% off</p><a class="button" href="https://s.test">Shop</a>',
        unsubscribeUrl: 'https://s.test/u',
      }).html,
    });
  }
  return out;
}

const RENDERED = renderAll();
const cases = RENDERED.map(r => [`${r.name} (${r.locale})`, r] as const);

describe('transactional emails are safe in clients that strip <style>', () => {
  it('covers every template file in email-templates/', () => {
    // A new template must be added to TEMPLATES, or it escapes these checks.
    const dir = resolve(__dirname, '../../apps/api/src/services/email-templates');
    const files = readdirSync(dir).filter((f: string) => !f.startsWith('_') && f.endsWith('.ts'));
    expect(files.length).toBe(Object.keys(TEMPLATES).length);
  });

  it.each(cases)('%s: every <img> is sized inline (width/height attrs + max-width)', (_n, r) => {
    const imgs = r.html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0); // the logo, at least
    for (const img of imgs) {
      const width = /\swidth="(\d+)"/.exec(img);
      expect(width, img).not.toBeNull();
      expect(Number(width![1]), img).toBeLessThanOrEqual(EMAIL_MAX_WIDTH);
      const style = /\sstyle="([^"]*)"/.exec(img)?.[1] ?? '';
      // Either a fixed width that can shrink with the column, or (a bounded
      // logo box) width:auto under a pixel max-width no wider than the column.
      const fixed = /(^|;)width:\d+px;max-width:100%;/.test(style);
      const boxed = /(^|;)width:auto;max-width:(\d+)px;/.exec(style);
      expect(fixed || (boxed !== null && Number(boxed[2]) <= EMAIL_MAX_WIDTH), img).toBe(true);
      // A fixed box (height attr) or a proportional height that is ALSO capped
      // (issue 2336: a square logo with only a width bound rendered 160px tall).
      const hasHeightAttr = /\sheight="\d+"/.test(img);
      expect(hasHeightAttr || /height:auto;max-height:\d+px;/.test(style), img).toBe(true);
    }
  });

  it.each(cases)('%s: no <style> block, no CSS the Gmail parser drops', (_n, r) => {
    expect(r.html).not.toMatch(/<style\b/i);
    expect(r.html).not.toMatch(/var\(--/);
    expect(r.html).not.toMatch(/color-mix\(|hsla?\(/);
  });

  it.each(cases)('%s: 600px container, fluid fallback', (_n, r) => {
    const page = /<table\b[^>]*class="page"[^>]*>/.exec(r.html)?.[0];
    expect(page).toBeDefined();
    expect(page).toContain(`width="${EMAIL_MAX_WIDTH}"`);
    expect(page).toMatch(new RegExp(`width:100%;max-width:${EMAIL_MAX_WIDTH}px;`));
    expect(EMAIL_MAX_WIDTH).toBeLessThanOrEqual(600);
    // Nothing inside may be wider than the container.
    for (const m of r.html.matchAll(/\swidth="(\d+)"|[;"]width:(\d+)px/g)) {
      expect(Number(m[1] ?? m[2])).toBeLessThanOrEqual(EMAIL_MAX_WIDTH);
    }
  });

  it.each(cases)('%s: viewport + light-only colour scheme meta', (_n, r) => {
    expect(r.html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    );
    expect(r.html).toContain('<meta name="color-scheme" content="light only">');
  });

  it.each(cases.filter(([, r]) => r.locale === 'ar'))('%s: Arabic wraps rtl', (_n, r) => {
    expect(r.html).toMatch(/<html dir="rtl"/);
    expect(r.html).toMatch(/<table\b[^>]*class="page" dir="rtl"/);
    expect(r.html).toMatch(/class="content" dir="rtl" align="right"/);
    expect(r.html).not.toMatch(/dir="auto"/);
  });
});

describe('invoice email', () => {
  it('is not the print page: one logo, a small PAID badge, 64px thumbnail', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = RENDERED.find(r => r.name === 'invoice' && r.locale === locale)!.html;
      expect(html.match(/logo-1600x420/g)).toHaveLength(1);
      expect(html).not.toContain('class="stamp');
      expect(html).toContain(locale === 'ar' ? '>مدفوع</span>' : '>PAID</span>');
      expect(html).toMatch(
        /<img src="https:\/\/pub\.r2\.dev\/product-1200x1600\.jpg"[^>]*width="64" height="64"/
      );
      // No display-size type anywhere (the watermark was 80px).
      for (const m of html.matchAll(/font-size:\s*(\d+)px/g)) {
        expect(Number(m[1])).toBeLessThanOrEqual(22);
      }
    }
  });

  it('the Inngest invoice-email function renders the email body, not the print page', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/api/src/lib/inngest/functions/invoice-email.ts'),
      'utf8'
    );
    expect(src).toContain('InvoiceService.generateInvoiceEmail(storeId, orderId)');
    expect(src).not.toMatch(/InvoiceService\.generateInvoice\(/);
  });

  it('generateInvoiceEmail reads the order through the shared loader', async () => {
    findFirst.mockResolvedValue(invoiceOrder('en'));
    const html = await InvoiceService.generateInvoiceEmail('s1', 'o1');
    expect(html).not.toMatch(/<html|<style/i);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1', storeId: 's1' } })
    );
  });

  it('RTL: amounts are aligned to the physical left end, phones stay LTR', () => {
    const ar = renderInvoiceEmailContent(
      { ...invoiceOrder('ar'), billingAddress: { ...addr, phone: '+965 6000 0000' } } as never,
      'ar'
    );
    expect(ar).toMatch(
      /<td align="left" style="padding:12px 0;vertical-align:top;text-align:left;/
    );
    expect(ar).toContain('<span dir="ltr">+965 6000 0000</span>');
  });
});

describe('logo scales down whole — never cropped', () => {
  // A wordmark (demo-store-style, ~4:1) and a square mark. The shell cannot know
  // the shape, so the guard is structural: a proportional image with a fixed
  // width and height:auto, and nothing that can clip it (object-fit, a fixed
  // height/max-height, or a fixed-height container with overflow:hidden).
  const logos = {
    wordmark: 'https://pub.r2.dev/logo-wordmark-1600x420.png',
    square: 'https://pub.r2.dev/logo-square-800x800.png',
  };

  const logoTag = (html: string, src: string) =>
    new RegExp(`<img src="${src.replace(/[.]/g, '\\.')}"[^>]*>`).exec(html)?.[0];

  it.each(
    (['en', 'ar'] as const).flatMap(locale =>
      Object.entries(logos).map(([shape, src]) => [`${shape} (${locale})`, locale, src] as const)
    )
  )(
    '%s: scaled whole into a 160×64 box, no object-fit / fixed height / overflow clip',
    (_n, locale, src) => {
      const html = renderBrandedShell('<p>hi</p>', { ...STORE(locale), logo: src });
      const img = logoTag(html, src);
      expect(img).toBeDefined();
      expect(img).toContain('width="160"'); // Outlook desktop's only bound
      expect(img).not.toMatch(/\sheight="/);
      const style = /\sstyle="([^"]*)"/.exec(img!)![1];
      // Issue 2336: both bounds, width:auto so neither one squashes the other.
      expect(style).toMatch(/(^|;)width:auto;max-width:160px;height:auto;max-height:64px;/);
      expect(style).not.toMatch(/object-fit|object-position|(^|;)height:\d|(^|;)width:\d/);
      // The cell holding the logo must not be a clipping box.
      const cell = /<td\b[^>]*class="header"[^>]*>/.exec(html)![0];
      expect(cell).not.toMatch(/\sheight="|[;"]height:\d|max-height|overflow/);
      expect(html).not.toMatch(/overflow:\s*hidden/);
    }
  );

  it('every rendered email: the logo carries no cropping style', () => {
    for (const r of RENDERED) {
      const img = logoTag(r.html, 'https://pub.r2.dev/logo-1600x420.png')!;
      expect(img, `${r.name} ${r.locale}`).not.toMatch(/object-fit|\sheight="|[;"]height:\d/);
      expect(img, `${r.name} ${r.locale}`).toMatch(/max-height:64px;/);
      expect(r.html, `${r.name} ${r.locale}`).not.toMatch(/overflow:\s*hidden/);
    }
  });
});
