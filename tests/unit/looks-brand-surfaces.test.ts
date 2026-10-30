/**
 * Brand surfaces outside the storefront follow the look (Ruling LOOKS-14).
 *
 * A look store's colours live in the look, not in `stores.theme`, so emails, invoices, campaign
 * mail and the setup guide used to read a raw `theme.primaryColor` that a look store never has:
 * every look store got the platform fallback colour and an unticked "brand" step. They now read
 * `storeBrandTheme` (composeStoreTheme for a look store, the stored theme for a legacy one).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getLook, hexToHsl } from '@ebda/shared';

const { state, sent } = vi.hoisted(() => ({
  state: { store: null as Record<string, unknown> | null, order: null as unknown },
  sent: [] as string[],
}));
vi.mock('@ebda/database', () => {
  const count = async () => 0;
  const tx = {
    store: {
      findUnique: async () =>
        state.store ?? (state.order as { store?: never } | null)?.store ?? null,
    },
  };
  return {
    prisma: {
      fiscalDocument: { findMany: async () => [] },
      order: { findFirst: async () => state.order, count },
      product: { count },
      shippingZone: { count },
      paymentConfig: { count },
    },
    withStore: async (_id: string, fn: (t: typeof tx) => unknown) => fn(tx),
  };
});
vi.mock('@api/lib/repo-factory', async () =>
  (await import('./helpers/invoice-repo-mock')).repoFactoryMock()
);
vi.mock('@api/lib/jobs/store-db', async () =>
  (await import('./helpers/invoice-repo-mock')).storeDbMock()
);
vi.mock('@api/services/store-mailer.service', () => ({
  StoreMailer: {
    sendBrandedEmail: async (_s: string, a: { html: string }) => {
      sent.push(a.html);
    },
  },
}));

const { storeBrandTheme } = await import('@api/lib/store-brand-theme');
const { InvoiceService, renderInvoiceEmailContent } = await import('@api/services/invoice.service');
const { EmailService } = await import('@api/services/email.service');
const { renderCampaignEmail } = await import('@api/services/campaign.service');
const { SetupGuideService } = await import('@api/services/setup-guide.service');
const { emailColor } = await import('@api/services/email-templates/_layout');

const LOOK = 'qamar.atelier';
const lookPrimary = hexToHsl(getLook(LOOK)!.tokens.primary);
const MERCHANT = '200 50% 40%';

type Kind = 'look' | 'legacy' | 'override';
const storeFor = (kind: Kind) => ({
  template: 'qamar',
  look: kind === 'legacy' ? null : LOOK,
  theme: kind === 'override' ? { primaryColor: MERCHANT } : {},
});

function order(kind: Kind) {
  return {
    id: 'o1',
    orderNumber: 'N-1',
    locale: 'en',
    currency: 'EGP',
    status: 'delivered',
    paymentStatus: 'paid',
    createdAt: new Date('2026-10-07T10:00:00Z'),
    subtotal: 10000,
    discount: 0,
    couponCode: null,
    couponDiscount: 0,
    promotionDiscount: 0,
    loyaltyDiscount: 0,
    loyaltyPointsRedeemed: null,
    tax: 0,
    taxIncludedInPrice: false,
    sellerTaxRegistrationNumber: null,
    sellerTaxLegalName: null,
    taxRateBps: null,
    shipping: 500,
    total: 10500,
    notes: null,
    shippingAddress: { firstName: 'A', lastName: 'B' },
    billingAddress: null,
    store: {
      name: 'Shop',
      email: null,
      phone: null,
      address: null,
      logo: null,
      currency: 'EGP',
      timezone: 'Africa/Cairo',
      ...storeFor(kind),
    },
    customer: null,
    items: [],
    payments: [],
    appliedPromotion: null,
  };
}

beforeEach(() => {
  sent.length = 0;
});

describe('storeBrandTheme', () => {
  it("look store with an empty theme: the look's primary", () => {
    expect(storeBrandTheme(storeFor('look'))?.primaryColor).toBe(lookPrimary);
  });
  it('a stored merchant colour wins over the look', () => {
    expect(storeBrandTheme(storeFor('override'))?.primaryColor).toBe(MERCHANT);
  });
  it('legacy store: the stored theme as-is (no skin colour invented)', () => {
    expect(storeBrandTheme(storeFor('legacy'))).toEqual({});
    expect(storeBrandTheme({ look: 'nope.unknown', theme: { a: 1 } })).toEqual({ a: 1 });
    expect(storeBrandTheme({ look: null, theme: null })).toBeNull();
  });
});

describe('invoices follow the look', () => {
  it("printable invoice paints the look's primary; a legacy store keeps the fallback", async () => {
    state.order = order('look');
    expect(await InvoiceService.generateInvoice('s1', 'o1', 'en')).toContain(`hsl(${lookPrimary})`);
    state.order = order('override');
    expect(await InvoiceService.generateInvoice('s1', 'o1', 'en')).toContain(`hsl(${MERCHANT})`);
    state.order = order('legacy');
    const legacy = await InvoiceService.generateInvoice('s1', 'o1', 'en');
    expect(legacy).toContain('hsl(210 9% 4%)');
    expect(legacy).not.toContain(`hsl(${lookPrimary})`);
  });
  it("invoice email uses the look's primary", () => {
    const hex = emailColor(lookPrimary);
    expect(renderInvoiceEmailContent(order('look') as never, 'en')).toContain(hex);
    expect(renderInvoiceEmailContent(order('legacy') as never, 'en')).not.toContain(hex);
  });
});

describe('store emails follow the look', () => {
  const sendFor = async (kind: Kind) => {
    state.store = {
      id: 's1',
      name: 'Shop',
      nameAr: null,
      logo: null,
      email: null,
      phone: null,
      address: null,
      settings: {},
      domain: null,
      emailSenderLocalPart: null,
      emailDomainStatus: null,
      ...storeFor(kind),
    };
    await (
      EmailService as unknown as {
        sendForStore: (
          id: string,
          a: { to: string; subject: string; content: string }
        ) => Promise<void>;
      }
    ).sendForStore('s1', { to: 'a@b.test', subject: 'S', content: '<p>x</p>' });
    return sent[sent.length - 1];
  };
  it("the branded shell uses the look's primary", async () => {
    const hex = emailColor(lookPrimary);
    expect(await sendFor('look')).toContain(hex);
    expect(await sendFor('override')).toContain(emailColor(MERCHANT));
    expect(await sendFor('legacy')).not.toContain(hex);
  });
  it("campaign mail uses the look's primary", () => {
    const render = (kind: Kind) =>
      renderCampaignEmail({
        store: {
          id: 's1',
          name: 'Shop',
          nameAr: null,
          logo: null,
          email: null,
          phone: null,
          address: null,
          settings: {},
          slug: 'shop',
          domain: null,
          emailSenderLocalPart: null,
          emailDomainStatus: null,
          ...storeFor(kind),
        },
        locale: 'en',
        subject: 'S',
        bodyHtml: '<p>x</p>',
        unsubscribeUrl: null,
      }).html;
    const hex = emailColor(lookPrimary);
    expect(render('look')).toContain(hex);
    expect(render('legacy')).not.toContain(hex);
  });
});

describe('setup guide: the brand step', () => {
  const brandDone = async (store: Record<string, unknown>) => {
    state.store = { logo: null, domain: null, settings: {}, ...store };
    const g = await SetupGuideService.get('s1');
    return g.items.find(i => i.key === 'brand')!.done;
  };
  it('is complete for a look store with no logo and no stored colour', async () => {
    expect(await brandDone({ look: LOOK, theme: {} })).toBe(true);
  });
  it('is complete for a stored primaryColor', async () => {
    expect(await brandDone({ look: null, theme: { primaryColor: MERCHANT } })).toBe(true);
  });
  it('is not complete for a legacy store with neither (nor an unknown look id)', async () => {
    expect(await brandDone({ look: null, theme: {} })).toBe(false);
    expect(await brandDone({ look: 'nope.unknown', theme: {} })).toBe(false);
  });
});
