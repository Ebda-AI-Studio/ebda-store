/**
 * SP8 — the order confirmation email carries the wa.me button when (and only
 * when) the store has a valid WhatsApp number.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaStoreFindUnique } = vi.hoisted(() => ({ prismaStoreFindUnique: vi.fn() }));
vi.mock('@force/database', () => ({ prisma: { store: { findUnique: prismaStoreFindUnique } } }));
vi.mock('@api/services/resend.service', () => ({
  ResendService: { sendBrandedEmail: vi.fn().mockResolvedValue({ id: 'em_test' }) },
}));
vi.mock('@api/config', () => ({
  config: {
    resendApiKey: 're_test',
    webUrl: 'https://store.test',
    adminUrl: 'https://admin.test',
    smtpFromEmail: 'noreply@test.com',
  },
}));

import { EmailService, type OrderEmailData } from '@api/services/email.service';
import { orderConfirmationTemplate } from '@api/services/email-templates/order-confirmation';
import { buildOrderEmailWaMe } from '@api/services/email-templates/_wa-me';
import { ResendService } from '@api/services/resend.service';

const data = (over: Partial<OrderEmailData> = {}): OrderEmailData => ({
  orderNumber: 'EB-1042',
  customerName: 'Mona',
  customerEmail: 'm@example.com',
  items: [{ name: 'Linen Shirt', nameAr: 'قميص كتان', quantity: 2, price: 62525 }],
  subtotal: 125050,
  tax: 0,
  shipping: 0,
  total: 125050,
  shippingAddress: {
    firstName: 'Mona',
    lastName: 'A',
    address1: '12 Tahrir St',
    city: 'Dokki',
    state: 'Giza',
    postalCode: '',
    country: 'Egypt',
  },
  ...over,
});

const storeRow = (over: Record<string, unknown> = {}) => ({
  id: 'st1',
  name: 'Nile Store',
  nameAr: 'متجر النيل',
  logo: null,
  theme: {},
  email: null,
  phone: null,
  domain: null,
  emailSenderLocalPart: 'noreply',
  emailDomainStatus: null,
  settings: {},
  whatsapp: '+201012345678',
  ...over,
});

const sentHtml = () =>
  vi.mocked(ResendService.sendBrandedEmail).mock.calls.at(-1)![1].html as string;
const waHrefs = (html: string) =>
  [...html.matchAll(/href="(https:\/\/wa\.me\/[^"]+)"/g)].map(m => m[1]);

describe('order confirmation email — wa.me button', () => {
  beforeEach(() => vi.clearAllMocks());

  it('COD order: confirmation prompt link with the prefilled COD text', async () => {
    prismaStoreFindUnique.mockResolvedValue(storeRow());
    await EmailService.sendOrderConfirmation('st1', data({ isCod: true }), 'en');
    const links = waHrefs(sentHtml());
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('https://wa.me/201012345678?text=');
    const text = decodeURIComponent(links[0].split('?text=')[1]);
    expect(text).toContain('#EB-1042');
    expect(text).toContain('Total: EGP 1,250.50');
    expect(text).toContain('Reply YES to confirm.');
    expect(sentHtml()).toContain('Confirm on WhatsApp');
  });

  it('Arabic COD email', async () => {
    prismaStoreFindUnique.mockResolvedValue(storeRow());
    await EmailService.sendOrderConfirmation('st1', data({ isCod: true }), 'ar');
    expect(sentHtml()).toContain('أكّد على واتساب');
    expect(decodeURIComponent(waHrefs(sentHtml())[0].split('?text=')[1])).toContain('1,250.50 ج.م');
  });

  it('non-COD order: "ask about your order" link', async () => {
    prismaStoreFindUnique.mockResolvedValue(storeRow());
    await EmailService.sendOrderConfirmation('st1', data(), 'en');
    expect(sentHtml()).toContain('Ask on WhatsApp');
    expect(decodeURIComponent(waHrefs(sentHtml())[0])).toContain(
      'question about my order #EB-1042'
    );
  });

  it('no number (or invalid) → no wa.me link at all', async () => {
    for (const whatsapp of [null, '', '555']) {
      prismaStoreFindUnique.mockResolvedValue(storeRow({ whatsapp }));
      await EmailService.sendOrderConfirmation('st1', data({ isCod: true }), 'en');
      expect(sentHtml()).not.toContain('wa.me');
    }
  });

  it('toggles: COD prompt off falls back to the question link; both off → none', () => {
    const base = { name: 'S', whatsapp: '01012345678' };
    const d = data({ isCod: true });
    expect(buildOrderEmailWaMe(d, { ...base, theme: { waMeCodConfirm: false } }, 'en')?.kind).toBe(
      'order_question'
    );
    expect(
      buildOrderEmailWaMe(
        d,
        { ...base, theme: { waMeCodConfirm: false, waMeOrderQuestion: false } },
        'en'
      )
    ).toBeUndefined();
  });

  it('template renders nothing extra without waMe data', () => {
    expect(orderConfirmationTemplate.en(data(), 'S')).not.toContain('wa.me');
    expect(orderConfirmationTemplate.ar(data(), 'S')).not.toContain('wa.me');
  });
});
